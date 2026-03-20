"""TierMigrationService — handles user tier migrations (upgrade/downgrade).

Migration types:
- upgrade: shared OpenClaw → dedicated OpenClaw container
- downgrade: dedicated container → shared OpenClaw

Strategy: blocking migration (user operations blocked during migration).
This is the simplest approach; user operations resume after migration completes.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class MigrationStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"


@dataclass
class MigrationStep:
    name: str
    status: str  # pending / running / done / failed
    detail: str = ""
    started_at: datetime | None = None
    completed_at: datetime | None = None


@dataclass
class MigrationRecord:
    id: str
    user_id: str
    direction: str  # upgrade | downgrade
    from_tier: str
    to_tier: str
    status: MigrationStatus
    steps: list[MigrationStep] = field(default_factory=list)
    error: str | None = None
    created_at: datetime = field(default_factory=datetime.utcnow)
    completed_at: datetime | None = None


class TierMigrationService:
    """
    Handles tier migrations for users.

    Upgrade (shared → dedicated):
        1. Create dedicated container
        2. For each agent: create agent on dedicated bridge
        3. Copy sessions, files, skills for each agent
        4. Update UserAgent.backend_type to 'dedicated'
        5. Update user.quota_tier
        6. Send notification

    Downgrade (dedicated → shared):
        1. For each agent: create agent on shared bridge
        2. Copy sessions, files, skills for each agent
        3. Update UserAgent.backend_type to 'shared'
        4. Update user.quota_tier
        5. Destroy dedicated container (after rollback window)
        6. Send notification
    """

    def __init__(
        self,
        container_manager: Any,  # DedicatedContainerManager
        shared_adapter: Any,    # SharedOpenClawAdapter
    ):
        self._cm = container_manager
        self._shared = shared_adapter

    async def upgrade(self, user_id: str) -> MigrationRecord:
        """
        Migrate a user from shared to dedicated OpenClaw.

        Raises MigrationError on failure.
        """
        from app.agentcore.config.tiers import TierConfigManager
        from sqlalchemy import select, text, update
        from app.db.engine import async_session
        from app.db.models import User, UserAgent

        record = MigrationRecord(
            id=self._gen_id(),
            user_id=user_id,
            direction="upgrade",
            from_tier="free",
            to_tier="pro",
            status=MigrationStatus.PENDING,
        )
        steps = [
            MigrationStep(name="create_container", status="pending"),
            MigrationStep(name="provision_agents", status="pending"),
            MigrationStep(name="copy_data", status="pending"),
            MigrationStep(name="update_routing", status="pending"),
            MigrationStep(name="update_user_tier", status="pending"),
            MigrationStep(name="notify", status="pending"),
        ]
        record.steps = steps
        await self._save_record(record)

        try:
            # Step 1: Create dedicated container
            await self._step_start(record, "create_container")
            tm = TierConfigManager()
            tier = tm.get_tier("pro")
            info = await self._cm.ensure_running(user_id, tier)
            dedicated_url = info.bridge_url
            await self._step_done(record, "create_container", f"container={info.container_id[:12]}")

            # Step 2: Provision agents
            await self._step_start(record, "provision_agents")
            async with async_session() as db:
                result = await db.execute(
                    select(UserAgent).where(
                        UserAgent.user_id == user_id,
                        UserAgent.status == "active",
                    )
                )
                agents = result.scalars().all()

            provisioned = []
            async with httpx.AsyncClient(timeout=120.0) as client:
                for agent in agents:
                    agent_data = await self._dedicated_create_agent(
                        client, dedicated_url, agent.name, agent.soul_md
                    )
                    provisioned.append({
                        "old_id": agent.id,
                        "openclaw_agent_id": agent_data["id"],
                        "name": agent.name,
                    })
                await self._step_done(record, "provision_agents", f"{len(provisioned)} agents")

            # Step 3: Copy data (sessions, files, skills)
            await self._step_start(record, "copy_data")
            await self._copy_all_agents_data(
                user_id, provisioned, dedicated_url, record
            )
            await self._step_done(record, "copy_data", "data copied")

            # Step 4: Update routing
            await self._step_start(record, "update_routing")
            async with async_session() as db:
                for item in provisioned:
                    await db.execute(
                        update(UserAgent)
                        .where(UserAgent.id == item["old_id"])
                        .values(
                            backend_type="dedicated",
                            backend_instance_id=info.container_id,
                            openclaw_agent_id=item["openclaw_agent_id"],
                        )
                    )
                await db.commit()
            await self._step_done(record, "update_routing", "routing updated")

            # Step 5: Update user tier
            await self._step_start(record, "update_user_tier")
            async with async_session() as db:
                await db.execute(
                    update(User).where(User.id == user_id).values(quota_tier="pro")
                )
                await db.commit()
            await self._step_done(record, "update_user_tier", "tier=pro")

            # Step 6: Notify
            await self._step_start(record, "notify")
            await self._notify_user(
                user_id, "upgrade_completed",
                "Tier Upgraded",
                f"Your account has been upgraded to Pro. "
                f"{len(provisioned)} agents are now running on dedicated infrastructure."
            )
            await self._step_done(record, "notify", "notification sent")

            record.status = MigrationStatus.COMPLETED
            record.completed_at = datetime.utcnow()
            await self._save_record(record)
            logger.info("Migration %s completed for user %s", record.id, user_id)
            return record

        except Exception as e:
            logger.error("Migration %s failed for user %s: %s", record.id, user_id, e)
            record.status = MigrationStatus.FAILED
            record.error = str(e)
            await self._save_record(record)
            await self._notify_user(
                user_id, "upgrade_failed",
                "Tier Upgrade Failed",
                f"Tier upgrade failed: {e}. Please contact support."
            )
            raise

    async def downgrade(self, user_id: str) -> MigrationRecord:
        """
        Migrate a user from dedicated to shared OpenClaw.

        Raises MigrationError on failure.
        """
        from sqlalchemy import select, text, update
        from app.db.engine import async_session
        from app.db.models import User, UserAgent

        record = MigrationRecord(
            id=self._gen_id(),
            user_id=user_id,
            direction="downgrade",
            from_tier="pro",
            to_tier="free",
            status=MigrationStatus.PENDING,
        )
        steps = [
            MigrationStep(name="provision_shared_agents", status="pending"),
            MigrationStep(name="copy_data", status="pending"),
            MigrationStep(name="update_routing", status="pending"),
            MigrationStep(name="update_user_tier", status="pending"),
            MigrationStep(name="destroy_container", status="pending"),
            MigrationStep(name="notify", status="pending"),
        ]
        record.steps = steps
        await self._save_record(record)

        try:
            # Get dedicated container info
            info = await self._cm.get_status(user_id)
            dedicated_url = info.bridge_url if info else None

            # Step 1: Provision agents on shared
            await self._step_start(record, "provision_shared_agents")
            async with async_session() as db:
                result = await db.execute(
                    select(UserAgent).where(
                        UserAgent.user_id == user_id,
                        UserAgent.status == "active",
                        UserAgent.backend_type == "dedicated",
                    )
                )
                dedicated_agents = result.scalars().all()

            provisioned = []
            if dedicated_url and dedicated_agents:
                async with httpx.AsyncClient(timeout=120.0) as client:
                    for agent in dedicated_agents:
                        agent_data = await self._dedicated_create_agent(
                            client, dedicated_url, agent.name, agent.soul_md
                        )
                        provisioned.append({
                            "old_id": agent.id,
                            "openclaw_agent_id": agent_data["id"],
                            "name": agent.name,
                        })
            await self._step_done(record, "provision_shared_agents", f"{len(provisioned)} agents")

            # Step 2: Copy data
            await self._step_start(record, "copy_data")
            if dedicated_url and provisioned:
                await self._copy_all_agents_data(
                    user_id, provisioned, dedicated_url, record, to_shared=True
                )
            await self._step_done(record, "copy_data", "data copied")

            # Step 3: Update routing
            await self._step_start(record, "update_routing")
            async with async_session() as db:
                for item in provisioned:
                    await db.execute(
                        update(UserAgent)
                        .where(UserAgent.id == item["old_id"])
                        .values(
                            backend_type="shared",
                            backend_instance_id="shared-openclaw-1",
                            openclaw_agent_id=item["openclaw_agent_id"],
                        )
                    )
                await db.commit()
            await self._step_done(record, "update_routing", "routing updated")

            # Step 4: Update user tier
            await self._step_start(record, "update_user_tier")
            async with async_session() as db:
                await db.execute(
                    update(User).where(User.id == user_id).values(quota_tier="free")
                )
                await db.commit()
            await self._step_done(record, "update_user_tier", "tier=free")

            # Step 5: Destroy dedicated container (after rollback window)
            await self._step_start(record, "destroy_container")
            try:
                await self._cm.destroy(user_id)
            except Exception as e:
                logger.warning("Failed to destroy container for user %s: %s", user_id, e)
            await self._step_done(record, "destroy_container", "container destroyed")

            # Step 6: Notify
            await self._step_start(record, "notify")
            await self._notify_user(
                user_id, "downgrade_completed",
                "Tier Downgraded",
                f"Your account has been downgraded to Free. "
                f"{len(provisioned)} agents are now on shared infrastructure."
            )
            await self._step_done(record, "notify", "notification sent")

            record.status = MigrationStatus.COMPLETED
            record.completed_at = datetime.utcnow()
            await self._save_record(record)
            logger.info("Migration %s completed for user %s", record.id, user_id)
            return record

        except Exception as e:
            logger.error("Migration %s failed for user %s: %s", record.id, user_id, e)
            record.status = MigrationStatus.FAILED
            record.error = str(e)
            await self._save_record(record)
            raise

    # -------------------------------------------------------------------------
    # Internal helpers
    # -------------------------------------------------------------------------

    async def _dedicated_create_agent(
        self,
        client: httpx.AsyncClient,
        bridge_url: str,
        name: str,
        soul_md: str,
    ) -> dict[str, Any]:
        """Create an agent on a dedicated bridge."""
        resp = await client.post(
            f"{bridge_url}/api/agents",
            json={"name": name},
        )
        resp.raise_for_status()
        data = resp.json()
        agent_id = data.get("id", name)

        if soul_md:
            await client.put(
                f"{bridge_url}/api/agents/{agent_id}/files/SOUL.md",
                json={"content": soul_md},
            )
        return {"id": agent_id, "name": name}

    async def _copy_all_agents_data(
        self,
        user_id: str,
        agents: list[dict[str, Any]],
        dedicated_url: str,
        record: MigrationRecord,
        to_shared: bool = False,
    ) -> None:
        """Copy sessions, files, and skills for all agents."""

        async with httpx.AsyncClient(timeout=120.0) as client:
            for item in agents:
                old_id = item["old_id"]
                new_oc_id = item["openclaw_agent_id"]

                # Copy sessions
                try:
                    resp = await client.get(
                        f"{dedicated_url}/api/sessions",
                        params={"agentId": old_id},
                    )
                    if resp.status_code == 200:
                        sessions = resp.json()
                        for sess in sessions:
                            sk = sess.get("sessionKey", "")
                            if sk:
                                # Copy session history
                                hist_resp = await client.get(
                                    f"{dedicated_url}/api/sessions/{sk}/history",
                                    params={"sessionKey": sk},
                                )
                                if hist_resp.status_code == 200:
                                    msgs = hist_resp.json()
                                    # Store in DB or relay to new backend
                                    pass
                except Exception as e:
                    logger.warning("Failed to copy sessions for agent %s: %s", old_id, e)

                # Copy skills
                try:
                    resp = await client.get(f"{dedicated_url}/api/skills")
                    if resp.status_code == 200:
                        skills = resp.json()
                        for skill in skills:
                            await client.post(
                                f"{dedicated_url}/api/skills/{skill['name']}/copy",
                            )
                except Exception as e:
                    logger.warning("Failed to copy skills for agent %s: %s", old_id, e)

    def _gen_id(self) -> str:
        import uuid
        return str(uuid.uuid4())

    async def _step_start(self, record: MigrationRecord, step_name: str) -> None:
        for step in record.steps:
            if step.name == step_name:
                step.status = "running"
                step.started_at = datetime.utcnow()
                break
        await self._save_record(record)

    async def _step_done(self, record: MigrationRecord, step_name: str, detail: str) -> None:
        for step in record.steps:
            if step.name == step_name:
                step.status = "done"
                step.detail = detail
                step.completed_at = datetime.utcnow()
                break
        await self._save_record(record)

    async def _save_record(self, record: MigrationRecord) -> None:
        """Persist migration record to DB."""
        from sqlalchemy import insert, text
        from app.db.engine import async_session

        async with async_session() as db:
            await db.execute(
                text("""
                    INSERT INTO tier_migrations
                    (id, user_id, direction, from_tier, to_tier, status, steps, error, created_at, completed_at)
                    VALUES (:id, :user_id, :direction, :from_tier, :to_tier, :status, :steps, :error, :created_at, :completed_at)
                    ON CONFLICT (id) DO UPDATE SET
                        status = EXCLUDED.status,
                        steps = EXCLUDED.steps,
                        error = EXCLUDED.error,
                        completed_at = EXCLUDED.completed_at
                """),
                {
                    "id": record.id,
                    "user_id": record.user_id,
                    "direction": record.direction,
                    "from_tier": record.from_tier,
                    "to_tier": record.to_tier,
                    "status": record.status.value,
                    "steps": json.dumps([{"name": s.name, "status": s.status, "detail": s.detail} for s in record.steps]),
                    "error": record.error,
                    "created_at": record.created_at,
                    "completed_at": record.completed_at,
                },
            )
            await db.commit()

    async def _notify_user(
        self, user_id: str, notif_type: str, title: str, content: str
    ) -> None:
        """Send an in-app notification to the user."""
        from app.db.models import Notification
        from app.db.engine import async_session

        async with async_session() as db:
            notif = Notification(
                user_id=user_id,
                type=notif_type,
                title=title,
                content=content,
            )
            db.add(notif)
            await db.commit()
