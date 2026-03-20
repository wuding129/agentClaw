"""DedicatedContainerManager — manages per-user OpenClaw container lifecycle.

Each pro/enterprise user gets their own OpenClaw container, managed here.
Lifecycle: ensure_running → stop (idle) → destroy (very old / deleted user).

Container naming: openclaw-user-{user_id}
Bridge port inside container: 18080 (fixed)
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

import docker
import httpx
from docker.errors import NotFound as DockerNotFound

from app.config import settings

if TYPE_CHECKING:
    from app.agentcore.config import TierConfig

logger = logging.getLogger(__name__)

_docker_client: docker.DockerClient | None = None


def _docker() -> docker.DockerClient:
    global _docker_client
    if _docker_client is None:
        _docker_client = docker.from_env()
    return _docker_client


def _ensure_network() -> None:
    """Create the internal Docker network if it doesn't exist."""
    client = _docker()
    try:
        client.networks.get(settings.container_network)
    except DockerNotFound:
        client.networks.create(
            settings.container_network,
            driver="bridge",
            internal=False,
        )
        logger.info("Created Docker network: %s", settings.container_network)


@dataclass
class ContainerInfo:
    """Info about a running dedicated container."""

    user_id: str
    container_id: str
    bridge_url: str  # e.g. "http://172.17.0.x:18080"
    gateway_ws_url: str  # e.g. "ws://172.17.0.x:18789"
    status: str  # creating / running / stopped / error
    container_token: str = ""  # token for LLM proxy auth within the container
    created_at: datetime = field(default_factory=datetime.utcnow)
    last_active_at: datetime = field(default_factory=datetime.utcnow)
    auto_stop_hours: int = 24
    auto_destroy_days: int = 90


class DedicatedContainerManager:
    """
    Manages all dedicated OpenClaw containers.

    Each pro/enterprise user has their own container.
    Containers are created on first use, stopped after idle_timeout,
    and destroyed after destroy_timeout or user deletion.

    Thread-safety: uses per-user asyncio Locks to prevent concurrent
    operations on the same user container.
    """

    def __init__(
        self,
        network_name: str | None = None,
        bridge_port: int = 18080,
        gateway_port: int = 18789,
        probe_timeout: int = 120,
    ):
        self._network = network_name or settings.container_network
        self._bridge_port = bridge_port
        self._gateway_port = gateway_port
        self._probe_timeout = probe_timeout

        # Per-user locks to prevent concurrent container operations
        self._locks: dict[str, asyncio.Lock] = {}
        self._containers: dict[str, ContainerInfo] = {}  # in-memory cache

        # Dedicated container volumes prefix
        self._workspace_vol_prefix = "openclaw-workspace-user-"
        self._sessions_vol_prefix = "openclaw-sessions-user-"

        # TierConfigManager lazy singleton (avoid circular import at module level)
        self._tier_manager = None

        # Ensure Docker network exists once at startup
        _ensure_network()

    def _lock(self, user_id: str) -> asyncio.Lock:
        """Get or create a lock for a specific user."""
        if user_id not in self._locks:
            self._locks[user_id] = asyncio.Lock()
        return self._locks[user_id]

    async def _tier_config_for_user(self, user_id: str) -> "TierConfig":
        """Look up a user's TierConfig from DB.

        Raises:
            ValueError: if the user's tier is not a dedicated backend.
        """
        from sqlalchemy import text
        from app.db.engine import async_session

        if self._tier_manager is None:
            from app.agentcore.config.tiers import TierConfigManager
            self._tier_manager = TierConfigManager()

        async with async_session() as db:
            result = await db.execute(
                text("SELECT quota_tier FROM users WHERE id = :uid"),
                {"uid": user_id},
            )
            row = result.mappings().first()
            tier_name = row["quota_tier"] if row else "pro"
        tier = self._tier_manager.get_tier(tier_name)
        if tier.backend != "dedicated":
            raise ValueError(
                f"User {user_id} has tier '{tier_name}' (backend={tier.backend}), "
                f"but dedicated adapter requires backend='dedicated'. "
                f"Check AgentCoreRouter routing logic."
            )
        return tier

    # -------------------------------------------------------------------------
    # Public API
    # -------------------------------------------------------------------------

    async def ensure_running(self, user_id: str, tier: "TierConfig") -> ContainerInfo:
        """
        Ensure the user's dedicated container is running.

        If stopped: unpause and wait for bridge to be ready.
        If not exists: create, start, and wait for bridge to be ready.
        If running: update last_active_at and return.
        """
        async with self._lock(user_id):
            # Check cache first
            if user_id in self._containers:
                info = self._containers[user_id]
                if info.status == "running":
                    info.last_active_at = datetime.utcnow()
                    return info

            # Load from DB or create
            info = await self._load_container_info(user_id)
            if info and info.status == "running":
                info.last_active_at = datetime.utcnow()
                self._containers[user_id] = info
                return info

            if info and info.status == "stopped":
                return await self._start_container(user_id, tier, info)

            # Create new container
            return await self._create_container(user_id, tier)

    async def stop(self, user_id: str) -> None:
        """Pause a running container (preserves data)."""
        async with self._lock(user_id):
            info = self._containers.get(user_id)
            if not info or info.status != "running":
                return

            try:
                client = _docker()
                container = client.containers.get(f"openclaw-user-{user_id}")
                container.pause()
                info.status = "stopped"
                await self._update_db_status(user_id, "stopped")
                logger.info("Stopped dedicated container for user %s", user_id)
            except DockerNotFound:
                logger.warning("Container for user %s not found when stopping", user_id)
            except Exception as e:
                logger.error("Failed to stop container for user %s: %s", user_id, e)

    async def destroy(self, user_id: str) -> None:
        """Permanently destroy a user's container and volumes."""
        async with self._lock(user_id):
            try:
                client = _docker()
                container_name = f"openclaw-user-{user_id}"

                # Stop and remove container
                try:
                    container = client.containers.get(container_name)
                    container.stop(timeout=10)
                    container.remove(v=True)
                    logger.info("Destroyed container %s", container_name)
                except DockerNotFound:
                    pass

                # Remove volumes
                for vol_name in [
                    f"{self._workspace_vol_prefix}{user_id}",
                    f"{self._sessions_vol_prefix}{user_id}",
                ]:
                    try:
                        client.volumes.get(vol_name).remove()
                        logger.debug("Removed volume %s", vol_name)
                    except DockerNotFound:
                        pass

                # Remove DB record
                await self._delete_db_record(user_id)

                # Clear cache
                self._containers.pop(user_id, None)

            except Exception as e:
                logger.error("Failed to destroy container for user %s: %s", user_id, e)
                raise

    async def get_status(self, user_id: str) -> ContainerInfo | None:
        """Get container info for a user (from cache or DB)."""
        if user_id in self._containers:
            return self._containers[user_id]
        return await self._load_container_info(user_id)

    async def health_check(self, user_id: str) -> bool:
        """Check if the user's bridge is reachable."""
        info = await self.get_status(user_id)
        if not info or info.status != "running":
            return False
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{info.bridge_url}/status")
                return resp.status_code == 200
        except httpx.RequestError:
            return False

    async def record_activity(self, user_id: str) -> None:
        """Record that a user was active (updates last_active_at)."""
        if user_id in self._containers:
            self._containers[user_id].last_active_at = datetime.utcnow()
        await self._update_db_last_active(user_id)

    # -------------------------------------------------------------------------
    # Container lifecycle
    # -------------------------------------------------------------------------

    async def _create_container(
        self, user_id: str, tier: "TierConfig"
    ) -> ContainerInfo:
        """Create a new dedicated container for a user."""
        client = _docker()

        container_name = f"openclaw-user-{user_id}"
        image = tier.container.image if tier.container else settings.openclaw_image
        memory = tier.container.memory if tier.container else "4g"
        cpus = tier.container.cpus if tier.container else 2
        pids_limit = tier.container.pids_limit if tier.container else 512
        auto_stop = tier.container.auto_stop_hours if tier.container else 24
        auto_destroy = tier.container.auto_destroy_days if tier.container else 90

        # Generate a unique container token for LLM proxy auth
        container_token = secrets.token_urlsafe(32)

        # Create volumes
        workspace_vol = f"{self._workspace_vol_prefix}{user_id}"
        sessions_vol = f"{self._sessions_vol_prefix}{user_id}"
        for vol_name in [workspace_vol, sessions_vol]:
            try:
                client.volumes.create(name=vol_name)
            except docker.errors.APIError:
                pass  # Already exists

        # Environment variables for the container
        env = [
            f"NANOBOT_PROXY__URL=http://platform-gateway:8080/llm/v1",
            f"NANOBOT_PROXY__TOKEN={container_token}",
            f"FRAMECLAW_PROXY__URL=http://platform-gateway:8080/llm/v1",
            f"FRAMECLAW_PROXY__TOKEN={container_token}",
            f"FRAMECLAW_AGENTS__DEFAULTS__MODEL={settings.default_model}",
            # Sandbox configuration
            "FRAMECLAW_AGENTS__DEFAULTS__SANDBOX__MODE=all",
            "FRAMECLAW_AGENTS__DEFAULTS__SANDBOX__SCOPE=agent",
            "FRAMECLAW_AGENTS__DEFAULTS__SANDBOX__PRUNE__IDLEHOURS=24",
        ]

        container = client.containers.run(
            image=image,
            name=container_name,
            detach=True,
            mem_limit=memory,
            nano_cpus=int(cpus * 1e9),
            pids_limit=pids_limit,
            environment=env,
            volumes={
                workspace_vol: {"bind": "/data/openclaw-workspace", "mode": "rw"},
                sessions_vol: {"bind": "/data/openclaw-sessions", "mode": "rw"},
            },
            network=self._network,
            restart_policy={"Name": "unless-stopped"},
            remove=False,
        )

        # Wait for network IP assignment
        await self._wait_for_network(container)

        container.reload()
        ip = self._get_container_ip(container)

        info = ContainerInfo(
            user_id=user_id,
            container_id=container.id,
            bridge_url=f"http://{ip}:{self._bridge_port}",
            gateway_ws_url=f"ws://{ip}:{self._gateway_port}",
            status="creating",
            container_token=container_token,
            created_at=datetime.utcnow(),
            last_active_at=datetime.utcnow(),
            auto_stop_hours=auto_stop,
            auto_destroy_days=auto_destroy,
        )

        # Wait for bridge HTTP server to be ready
        await self._probe_bridge(info.bridge_url)
        info.status = "running"

        # Persist to DB
        await self._save_container_info(info)

        self._containers[user_id] = info
        logger.info(
            "Created dedicated container for user %s: %s (bridge: %s)",
            user_id,
            container.id[:12],
            info.bridge_url,
        )
        return info

    async def _start_container(
        self, user_id: str, tier: "TierConfig", info: ContainerInfo
    ) -> ContainerInfo:
        """Resume a paused container."""
        client = _docker()
        try:
            container = client.containers.get(f"openclaw-user-{user_id}")
            container.unpause()
            info.status = "creating"
            await self._probe_bridge(info.bridge_url)
            info.status = "running"
            info.last_active_at = datetime.utcnow()
            await self._update_db_status(user_id, "running")
            self._containers[user_id] = info
            logger.info("Resumed dedicated container for user %s", user_id)
            return info
        except DockerNotFound:
            # Container was deleted externally, recreate
            return await self._create_container(user_id, tier)

    def _get_container_ip(self, container) -> str:
        """Get the container's IP in the internal network."""
        try:
            networks = container.attrs.get("NetworkSettings", {}).get("Networks", {})
            for net_name, net_info in networks.items():
                if net_name == self._network:
                    return net_info.get("IPAddress", "")
            # Fallback: return first available IP
            for net_info in networks.values():
                ip = net_info.get("IPAddress", "")
                if ip:
                    return ip
        except Exception:
            pass
        return "172.17.0.2"  # Fallback IP

    async def _wait_for_network(self, container, timeout: int = 30) -> None:
        """Wait for the container to get an IP in the network."""
        start = asyncio.get_event_loop().time()
        while asyncio.get_event_loop().time() - start < timeout:
            await asyncio.sleep(1)
            try:
                container.reload()
                ip = self._get_container_ip(container)
                if ip:
                    return
            except Exception:
                pass
        logger.warning("Container %s may not have IP assigned yet", container.id[:12])

    async def _probe_bridge(self, bridge_url: str) -> bool:
        """Wait for bridge HTTP server to respond 200."""
        async with httpx.AsyncClient() as client:
            start = asyncio.get_event_loop().time()
            while asyncio.get_event_loop().time() - start < self._probe_timeout:
                try:
                    resp = await client.get(f"{bridge_url}/status")
                    if resp.status_code == 200:
                        return True
                except httpx.RequestError:
                    pass
                await asyncio.sleep(2)
        raise TimeoutError(f"Bridge not ready at {bridge_url} after {self._probe_timeout}s")

    # -------------------------------------------------------------------------
    # DB operations (using dedicated_containers table)
    # -------------------------------------------------------------------------

    async def _get_db_record(self, user_id: str) -> dict | None:
        """Load dedicated container record from DB."""
        from sqlalchemy import select, text
        from app.db.engine import async_session

        async with async_session() as db:
            result = await db.execute(
                text("""
                    SELECT docker_id, bridge_url, gateway_ws_url, status,
                           created_at, last_active_at, auto_stop_hours, auto_destroy_days,
                           container_token
                    FROM dedicated_containers
                    WHERE user_id = :user_id
                """),
                {"user_id": user_id},
            )
            row = result.mappings().first()
            return dict(row) if row else None

    async def _save_container_info(self, info: ContainerInfo) -> None:
        """Save container info to DB (upsert)."""
        from sqlalchemy import insert, text, update
        from app.db.engine import async_session

        async with async_session() as db:
            # Try update first, then insert
            result = await db.execute(
                text("SELECT 1 FROM dedicated_containers WHERE user_id = :user_id"),
                {"user_id": info.user_id},
            )
            exists = result.scalar() is not None

            if exists:
                await db.execute(
                    text("""
                        UPDATE dedicated_containers
                        SET docker_id=:docker_id, bridge_url=:bridge_url,
                            gateway_ws_url=:gateway_ws_url, status=:status,
                            last_active_at=:last_active_at,
                            auto_stop_hours=:auto_stop_hours,
                            auto_destroy_days=:auto_destroy_days
                        WHERE user_id = :user_id
                    """),
                    {
                        "user_id": info.user_id,
                        "docker_id": info.container_id,
                        "bridge_url": info.bridge_url,
                        "gateway_ws_url": info.gateway_ws_url,
                        "status": info.status,
                        "last_active_at": info.last_active_at,
                        "auto_stop_hours": info.auto_stop_hours,
                        "auto_destroy_days": info.auto_destroy_days,
                    },
                )
            else:
                await db.execute(
                    insert(text("dedicated_containers")).values(
                        user_id=info.user_id,
                        docker_id=info.container_id,
                        bridge_url=info.bridge_url,
                        gateway_ws_url=info.gateway_ws_url,
                        container_token=info.container_token,
                        status=info.status,
                        created_at=info.created_at,
                        last_active_at=info.last_active_at,
                        auto_stop_hours=info.auto_stop_hours,
                        auto_destroy_days=info.auto_destroy_days,
                    )
                )
            await db.commit()

    async def _load_container_info(self, user_id: str) -> ContainerInfo | None:
        """Load container info from DB."""
        row = await self._get_db_record(user_id)
        if not row:
            return None
        return ContainerInfo(
            user_id=user_id,
            container_id=row["docker_id"] or "",
            bridge_url=row["bridge_url"] or "",
            gateway_ws_url=row["gateway_ws_url"] or "",
            status=row["status"] or "stopped",
            container_token=row.get("container_token") or "",
            created_at=row["created_at"] or datetime.utcnow(),
            last_active_at=row["last_active_at"] or datetime.utcnow(),
            auto_stop_hours=row.get("auto_stop_hours") or 24,
            auto_destroy_days=row.get("auto_destroy_days") or 90,
        )

    async def _update_db_status(self, user_id: str, status: str) -> None:
        """Update container status in DB."""
        from sqlalchemy import text
        from app.db.engine import async_session

        async with async_session() as db:
            await db.execute(
                text("UPDATE dedicated_containers SET status=:s WHERE user_id=:u"),
                {"s": status, "u": user_id},
            )
            await db.commit()

    async def _update_db_last_active(self, user_id: str) -> None:
        """Update last_active_at in DB."""
        from sqlalchemy import text
        from app.db.engine import async_session

        async with async_session() as db:
            await db.execute(
                text("UPDATE dedicated_containers SET last_active_at=NOW() WHERE user_id=:u"),
                {"u": user_id},
            )
            await db.commit()

    async def _delete_db_record(self, user_id: str) -> None:
        """Delete container record from DB."""
        from sqlalchemy import text
        from app.db.engine import async_session

        async with async_session() as db:
            await db.execute(
                text("DELETE FROM dedicated_containers WHERE user_id=:u"),
                {"u": user_id},
            )
            await db.commit()

    # -------------------------------------------------------------------------
    # Background idle checker
    # -------------------------------------------------------------------------

    async def run_idle_checker(self, interval_hours: int = 1) -> None:
        """
        Background task: periodically check all dedicated containers.
        - Stop containers idle beyond auto_stop_hours
        - Destroy containers idle beyond auto_destroy_days
        """
        while True:
            await asyncio.sleep(interval_hours * 3600)
            try:
                await self._check_idle_containers()
            except Exception as e:
                logger.error("Idle checker error: %s", e)

    async def _check_idle_containers(self) -> None:
        """Check all dedicated containers and stop/destroy as needed."""
        from sqlalchemy import text
        from app.db.engine import async_session

        async with async_session() as db:
            result = await db.execute(
                text("SELECT user_id FROM dedicated_containers")
            )
            user_ids = [row["user_id"] for row in result.mappings().all()]

        now = datetime.utcnow()
        stopped = 0
        destroyed = 0

        for user_id in user_ids:
            info = await self._load_container_info(user_id)
            if info is None:
                continue
            idle_hours = (now - info.last_active_at).total_seconds() / 3600

            if info.status == "running" and idle_hours >= info.auto_stop_hours:
                await self.stop(user_id)
                stopped += 1
                logger.info("Idle stop: user %s (idle %.1fh > %dh)", user_id, idle_hours, info.auto_stop_hours)

            elif info.status == "stopped" and idle_hours >= info.auto_destroy_days * 24:
                await self.destroy(user_id)
                destroyed += 1
                logger.info("Idle destroy: user %s (idle %.1fd > %dd)", user_id, idle_hours / 24, info.auto_destroy_days)

        if stopped or destroyed:
            logger.info("Idle check complete: %d stopped, %d destroyed", stopped, destroyed)


# -----------------------------------------------------------------------------
# Module-level singleton
# -----------------------------------------------------------------------------

_manager: DedicatedContainerManager | None = None


def get_container_manager() -> DedicatedContainerManager:
    """Get the global DedicatedContainerManager singleton."""
    global _manager
    if _manager is None:
        _manager = DedicatedContainerManager()
    return _manager
