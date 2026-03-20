"""DedicatedOpenClawAdapter — per-user dedicated OpenClaw container as IAgentCore.

Each user (identified by user_id) gets their own OpenClaw instance in a dedicated
Docker container, managed by DedicatedContainerManager.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from app.container.dedicated_manager import DedicatedContainerManager

import httpx

from app.agentcore.interfaces import (
    AgentConfig,
    AgentStatus,
    BackendType,
    CoreEvent,
    CoreInstanceInfo,
    EventType,
    IAgentCore,
    ResourceUsage,
    Session,
    SkillInfo,
    WorkspaceFile,
)
from app.config import settings


def _sign_agent_id(agent_id: str, token: str) -> str:
    """Sign agentId to prevent tampering."""
    message = f"{agent_id}:{token}"
    return hmac.new(
        token.encode(),
        message.encode(),
        hashlib.sha256,
    ).hexdigest()[:16]


def _sign_is_admin(agent_id: str, is_admin: bool, token: str) -> str:
    """Sign isAdmin parameter."""
    admin_str = "true" if is_admin else "false"
    message = f"{agent_id}:{admin_str}:{token}"
    return hmac.new(
        token.encode(),
        message.encode(),
        hashlib.sha256,
    ).hexdigest()[:16]


class DedicatedOpenClawAdapter(IAgentCore):
    """
    IAgentCore implementation for a user's dedicated OpenClaw container.

    Each user_id maps to one adapter instance.
    The container is created on first use via DedicatedContainerManager.
    """

    backend_type = BackendType.DEDICATED_OPENCLAW

    def __init__(
        self,
        user_id: str,
        container_manager: "DedicatedContainerManager",
    ):
        self.user_id = user_id
        self.instance_id = f"dedicated-{user_id}"
        self._cm = container_manager
        self._http: httpx.AsyncClient | None = None

    @property
    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=120.0)
        return self._http

    async def close(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def initialize(self) -> None:
        """
        Ensure the dedicated container is running.
        Called by AgentCoreRouter when provisioning a dedicated adapter.
        """
        tier_config = await self._cm._tier_config_for_user(self.user_id)
        info = await self._cm.ensure_running(self.user_id, tier_config)
        self.set_token(info.container_token)

    def _bridge_headers(self, agent_id: str, is_admin: bool = False) -> dict[str, str]:
        """Build bridge request headers using the container's own token."""
        # Token is loaded lazily from container info on first call per adapter instance
        if not hasattr(self, "_cached_token") or not self._cached_token:
            # Synchronous access: get from cache if available, else leave empty
            # The token is set during ensure_running flow via set_token()
            pass
        token = getattr(self, "_cached_token", "") or settings.bridge_token
        return {
            "X-Agent-Id": agent_id,
            "X-Agent-Id-Sig": _sign_agent_id(agent_id, token),
            "X-Is-Admin": "true" if is_admin else "false",
        }

    def set_token(self, token: str) -> None:
        """Set the container token after initialization."""
        self._cached_token = token

    async def _ensure_token(self) -> str:
        """Ensure we have the current container token, refreshing if needed."""
        info = await self._cm.get_status(self.user_id)
        if info and info.container_token:
            self.set_token(info.container_token)
        return getattr(self, "_cached_token", "") or settings.bridge_token

    async def _get_bridge_url(self) -> str:
        """Get the bridge URL from the container info."""
        info = await self._cm.get_status(self.user_id)
        if info is None:
            raise RuntimeError(f"No container found for user {self.user_id}")
        if info.container_token:
            self.set_token(info.container_token)
        return info.bridge_url
        return info.bridge_url

    def _normalize_event(self, raw: dict[str, Any]) -> CoreEvent:
        """Convert bridge WS event to normalized CoreEvent."""
        event_name = raw.get("event", "")
        payload = raw.get("payload", {})
        type_map = {
            "chat.message.received": EventType.MESSAGE,
            "chat.tool.call": EventType.TOOL_CALL,
            "chat.tool.start": EventType.TOOL_START,
            "chat.tool.result": EventType.TOOL_RESULT,
            "chat.tool.end": EventType.TOOL_END,
            "session.created": EventType.SESSION_CREATED,
            "session.deleted": EventType.SESSION_DELETED,
            "agent.stopped": EventType.AGENT_STOPPED,
            "error": EventType.ERROR,
        }
        return CoreEvent(
            event_type=type_map.get(event_name, EventType.STREAMING),
            session_key=payload.get("sessionKey", ""),
            content=payload.get("content", ""),
            metadata=payload,
        )

    # -------------------------------------------------------------------------
    # Agent lifecycle
    # -------------------------------------------------------------------------

    async def create_agent(self, config: AgentConfig) -> str:
        """Create an agent on the user's dedicated OpenClaw instance."""
        # Ensure container is running first
        tier = self._cm._tier_config_for_user(self.user_id)  # type: ignore
        await self._cm.ensure_running(self.user_id, tier)

        bridge_url = await self._get_bridge_url()

        resp = await self._client.post(
            f"{bridge_url}/api/agents",
            json={"name": config.name, "agentId": config.name},
            headers=self._bridge_headers(config.name, is_admin=True),
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Failed to create agent: {resp.status_code} {resp.text}")

        data = resp.json()
        agent_id = data.get("id", config.name)

        if config.personality:
            await self._client.put(
                f"{bridge_url}/api/agents/{agent_id}/files/SOUL.md",
                json={"content": config.personality},
                headers=self._bridge_headers(agent_id, is_admin=True),
            )

        return agent_id

    async def delete_agent(self, agent_id: str) -> None:
        """Delete an agent from the user's dedicated OpenClaw."""
        bridge_url = await self._get_bridge_url()
        await self._client.delete(
            f"{bridge_url}/api/agents/{agent_id}",
            params={"delete_files": "true"},
            headers=self._bridge_headers(agent_id, is_admin=True),
        )

    async def get_agent_status(self, agent_id: str) -> AgentStatus:
        """Get agent status."""
        bridge_url = await self._get_bridge_url()
        try:
            resp = await self._client.get(
                f"{bridge_url}/api/agents/{agent_id}/status",
                headers=self._bridge_headers(agent_id),
                timeout=10.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                return AgentStatus(
                    agent_id=agent_id,
                    status=data.get("status", "running"),
                    sandbox_status=data.get("sandbox_status"),
                )
        except httpx.RequestError:
            pass
        return AgentStatus(agent_id=agent_id, status="running")

    # -------------------------------------------------------------------------
    # Session management
    # -------------------------------------------------------------------------

    async def send_message(
        self,
        agent_id: str,
        session_key: str,
        message: str,
        on_event: Callable[[CoreEvent], None] | None = None,
    ) -> None:
        """Send a message via WebSocket relay."""
        import websockets

        # Ensure container is running and token is current
        info = await self._cm.get_status(self.user_id)
        if info is None:
            raise RuntimeError(f"No container for user {self.user_id}")
        self.set_token(info.container_token)

        # Record activity on every message
        await self._cm.record_activity(self.user_id)

        scoped_session = f"agent:{agent_id}:{session_key}"

        ws_url = info.gateway_ws_url.replace("ws://", "ws://").rstrip("/")
        if not ws_url.endswith("/ws"):
            ws_url = ws_url.rstrip("/") + "/ws"
        ws_url += f"?agentId={agent_id}&isAdmin=false"

        if on_event is None:
            return

        try:
            async with websockets.connect(ws_url, origin="http://127.0.0.1:8080") as ws:
                req = {
                    "type": "req",
                    "id": 1,
                    "method": "chat.send",
                    "params": {"sessionKey": scoped_session, "message": message},
                }
                await ws.send(json.dumps(req))
                async for raw in ws:
                    try:
                        event_dict = json.loads(raw)
                        if event_dict.get("type") == "event":
                            event = self._normalize_event(event_dict)
                            on_event(event)
                            if event.event_type in (EventType.DONE, EventType.ERROR):
                                break
                    except json.JSONDecodeError:
                        continue
        except Exception as e:
            on_event(CoreEvent(
                event_type=EventType.ERROR,
                session_key=scoped_session,
                content=str(e),
            ))

    async def list_sessions(self, agent_id: str) -> list[Session]:
        """List sessions."""
        bridge_url = await self._get_bridge_url()
        try:
            resp = await self._client.get(
                f"{bridge_url}/api/sessions",
                headers=self._bridge_headers(agent_id),
                params={"agentId": agent_id},
                timeout=10.0,
            )
            if resp.status_code == 200:
                raw = resp.json()
                return [
                    Session(
                        session_key=s.get("sessionKey", ""),
                        created_at=datetime.fromisoformat(s.get("createdAt", "1970-01-01T00:00:00")),
                        last_active_at=datetime.fromisoformat(s.get("lastActiveAt", "1970-01-01T00:00:00")),
                        message_count=s.get("messageCount", 0),
                    )
                    for s in raw
                ]
        except httpx.RequestError:
            pass
        return []

    async def delete_session(self, agent_id: str, session_key: str) -> None:
        """Delete a session."""
        bridge_url = await self._get_bridge_url()
        scoped = f"agent:{agent_id}:{session_key}"
        await self._client.delete(
            f"{bridge_url}/api/sessions/{scoped}",
            headers=self._bridge_headers(agent_id),
        )

    async def get_session_history(
        self, agent_id: str, session_key: str, limit: int | None = None
    ) -> list[dict[str, Any]]:
        """Get session history."""
        bridge_url = await self._get_bridge_url()
        scoped = f"agent:{agent_id}:{session_key}"
        params: dict[str, Any] = {"sessionKey": scoped}
        if limit:
            params["limit"] = limit
        try:
            resp = await self._client.get(
                f"{bridge_url}/api/sessions/{scoped}/history",
                headers=self._bridge_headers(agent_id),
                params=params,
                timeout=10.0,
            )
            if resp.status_code == 200:
                return resp.json()
        except httpx.RequestError:
            pass
        return []

    # -------------------------------------------------------------------------
    # Workspace / Files
    # -------------------------------------------------------------------------

    async def get_workspace_path(self, agent_id: str) -> Path:
        return Path.home() / ".openclaw" / f"workspace-{agent_id}"

    async def list_workspace_files(
        self, agent_id: str, path: str | None = None
    ) -> list[WorkspaceFile]:
        bridge_url = await self._get_bridge_url()
        params: dict[str, Any] = {}
        if path:
            params["path"] = path
        try:
            resp = await self._client.get(
                f"{bridge_url}/api/agents/{agent_id}/files",
                headers=self._bridge_headers(agent_id),
                params=params,
                timeout=10.0,
            )
            if resp.status_code == 200:
                raw = resp.json()
                if isinstance(raw, list):
                    return [
                        WorkspaceFile(
                            name=f.get("name", ""),
                            path=f.get("path", ""),
                            type=f.get("type", "file"),
                            size=f.get("size", 0),
                            modified_at=datetime.fromisoformat(f["modifiedAt"])
                            if f.get("modifiedAt")
                            else None,
                        )
                        for f in raw
                    ]
        except httpx.RequestError:
            pass
        return []

    async def read_workspace_file(self, agent_id: str, path: str) -> bytes:
        bridge_url = await self._get_bridge_url()
        resp = await self._client.get(
            f"{bridge_url}/api/agents/{agent_id}/files/{path}",
            headers=self._bridge_headers(agent_id),
            timeout=30.0,
        )
        if resp.status_code == 200:
            return resp.content
        raise FileNotFoundError(f"File not found: {path}")

    async def write_workspace_file(
        self, agent_id: str, path: str, content: bytes
    ) -> None:
        bridge_url = await self._get_bridge_url()
        resp = await self._client.put(
            f"{bridge_url}/api/agents/{agent_id}/files/{path}",
            json={"content": content.decode("utf-8", errors="replace")},
            headers=self._bridge_headers(agent_id),
            timeout=30.0,
        )
        if resp.status_code not in (200, 201):
            raise IOError(f"Failed to write {path}: {resp.status_code}")

    async def delete_workspace_file(self, agent_id: str, path: str) -> None:
        bridge_url = await self._get_bridge_url()
        await self._client.delete(
            f"{bridge_url}/api/agents/{agent_id}/files/{path}",
            headers=self._bridge_headers(agent_id),
        )

    async def prune_sandbox(self, agent_id: str) -> None:
        bridge_url = await self._get_bridge_url()
        try:
            await self._client.post(
                f"{bridge_url}/api/agents/{agent_id}/prune",
                headers=self._bridge_headers(agent_id, is_admin=True),
                timeout=10.0,
            )
        except httpx.RequestError:
            pass

    # -------------------------------------------------------------------------
    # Skills
    # -------------------------------------------------------------------------

    async def list_skills(self, agent_id: str) -> list[SkillInfo]:
        bridge_url = await self._get_bridge_url()
        try:
            resp = await self._client.get(
                f"{bridge_url}/api/skills",
                headers=self._bridge_headers(agent_id),
                timeout=10.0,
            )
            if resp.status_code == 200:
                raw = resp.json()
                if isinstance(raw, list):
                    return [
                        SkillInfo(
                            name=s.get("name", ""),
                            description=s.get("description", ""),
                            enabled=s.get("enabled", True),
                            author=s.get("author", ""),
                        )
                        for s in raw
                    ]
        except httpx.RequestError:
            pass
        return []

    async def install_skill(self, agent_id: str, skill_name: str) -> None:
        bridge_url = await self._get_bridge_url()
        resp = await self._client.post(
            f"{bridge_url}/api/skills/{skill_name}/copy",
            headers=self._bridge_headers(agent_id, is_admin=True),
            timeout=30.0,
        )
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"Failed to install skill {skill_name}: {resp.status_code}")

    async def uninstall_skill(self, agent_id: str, skill_name: str) -> None:
        bridge_url = await self._get_bridge_url()
        await self._client.delete(
            f"{bridge_url}/api/skills/{skill_name}",
            headers=self._bridge_headers(agent_id),
        )

    # -------------------------------------------------------------------------
    # Resource & Health
    # -------------------------------------------------------------------------

    async def get_resource_usage(self, agent_id: str) -> ResourceUsage:
        bridge_url = await self._get_bridge_url()
        try:
            resp = await self._client.get(
                f"{bridge_url}/api/status",
                headers=self._bridge_headers(agent_id, is_admin=True),
                timeout=10.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                return ResourceUsage(
                    cpu_percent=data.get("cpu_percent", 0.0),
                    memory_mb=data.get("memory_mb", 0),
                    sandbox_count=data.get("sandbox_count", 0),
                    active_sessions=data.get("active_sessions", 0),
                )
        except httpx.RequestError:
            pass
        return ResourceUsage()

    async def get_instance_info(self) -> CoreInstanceInfo:
        return CoreInstanceInfo(
            instance_id=self.instance_id,
            backend_type=self.backend_type,
            version=settings.openclaw_image,
            max_agents=None,
            max_sandboxes=None,
        )

    async def health_check(self) -> bool:
        info = await self._cm.get_status(self.user_id)
        if info is None or info.status != "running":
            return False
        try:
            resp = await self._client.get(f"{info.bridge_url}/status", timeout=5.0)
            return resp.status_code == 200
        except httpx.RequestError:
            return False
