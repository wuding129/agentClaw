"""Admin API routes for user and system management."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import require_admin
from app.config import settings
from app.container.shared_manager import ensure_shared_container, get_shared_container_info
from app.db.engine import get_db
from app.db.models import UsageRecord, User, UserAgent

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])


class UserSummary(BaseModel):
    id: str
    username: str
    email: str
    role: str
    quota_tier: str
    is_active: bool
    tokens_used_today: int = 0
    container_status: str | None = None
    container_cpu: float | None = None
    container_memory: str | None = None
    container_memory_percent: float | None = None


# Valid tier names — must match tiers.yaml
VALID_TIERS = frozenset({"free", "basic", "pro", "enterprise"})


class UpdateUserRequest(BaseModel):
    role: str | None = None
    quota_tier: str | None = None
    is_active: bool | None = None

    def validate_tier(self) -> str | None:
        """Validate quota_tier value. Returns error message or None if valid."""
        if self.quota_tier is None:
            return None
        if self.quota_tier not in VALID_TIERS:
            return f"Invalid quota_tier '{self.quota_tier}'. Must be one of: {', '.join(sorted(VALID_TIERS))}"
        return None


async def _delete_agent_by_openclaw_id(openclaw_agent_id: str) -> bool:
    """Delete an Agent from the shared OpenClaw instance by its openclaw_agent_id.

    Returns True if successful, False otherwise.
    """
    if settings.dev_openclaw_url:
        bridge_url = settings.dev_openclaw_url
    else:
        container_info = await ensure_shared_container()
        bridge_url = f"http://{container_info['internal_host']}:{container_info['internal_port']}"

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.delete(
                f"{bridge_url}/api/agents/{openclaw_agent_id}",
                params={"delete_files": "true"},
            )
            return resp.status_code == 200
    except Exception as e:
        print(f"[admin] Failed to delete agent {openclaw_agent_id}: {e}")
        return False


@router.get("/users", response_model=list[UserSummary])
async def list_users(db: AsyncSession = Depends(get_db)):
    """List all users with their usage stats and container status."""
    users = (await db.execute(select(User))).scalars().all()
    result = []

    # Get shared container info for status lookup
    container_info = await get_shared_container_info()

    # Build user_id -> openclaw_agent_id mapping for container status lookup
    user_ids = [u.id for u in users]
    agent_rows = (await db.execute(
        select(UserAgent).where(
            UserAgent.user_id.in_(user_ids),
            UserAgent.is_default == True,
            UserAgent.status == "active",
        )
    )).scalars().all()
    user_to_openclaw_id: dict[str, str] = {a.user_id: a.openclaw_agent_id for a in agent_rows}

    for u in users:
        # Today's usage
        today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        used = (await db.execute(
            select(func.coalesce(func.sum(UsageRecord.total_tokens), 0)).where(
                UsageRecord.user_id == u.id,
                UsageRecord.created_at >= today_start,
            )
        )).scalar_one()

        # Get agent sandbox status from shared openclaw
        container_status = None
        container_cpu = None
        container_memory = None
        container_memory_percent = None

        openclaw_id = user_to_openclaw_id.get(u.id)
        if container_info.get('status') == 'running' and openclaw_id:
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.get(
                        f"http://{container_info['internal_host']}:{container_info['internal_port']}/api/agents/{openclaw_id}/status"
                    )
                    if resp.status_code == 200:
                        status_data = resp.json()
                        container_status = status_data.get('status', 'unknown')
                        container_cpu = status_data.get('cpu_percent')
                        container_memory = status_data.get('memory_usage')
                        container_memory_percent = status_data.get('memory_percent')
            except Exception:
                pass

        result.append(UserSummary(
            id=u.id,
            username=u.username,
            email=u.email,
            role=u.role,
            quota_tier=u.quota_tier,
            is_active=u.is_active,
            tokens_used_today=used,
            container_status=container_status,
            container_cpu=container_cpu,
            container_memory=container_memory,
            container_memory_percent=container_memory_percent,
        ))
    return result


@router.put("/users/{user_id}")
async def update_user(user_id: str, req: UpdateUserRequest, db: AsyncSession = Depends(get_db)):
    """Update user properties."""
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    # Validate tier before applying
    tier_error = req.validate_tier()
    if tier_error:
        raise HTTPException(status_code=400, detail=tier_error)

    values = {k: v for k, v in req.model_dump().items() if v is not None}
    if values:
        await db.execute(update(User).where(User.id == user_id).values(**values))
        await db.commit()
    return {"ok": True}


@router.get("/usage/summary")
async def usage_summary(db: AsyncSession = Depends(get_db)):
    """Global usage summary for the platform."""
    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    total_today = (await db.execute(
        select(func.coalesce(func.sum(UsageRecord.total_tokens), 0)).where(
            UsageRecord.created_at >= today_start,
        )
    )).scalar_one()
    total_users = (await db.execute(select(func.count(User.id)))).scalar_one()

    return {
        "total_tokens_today": total_today,
        "total_users": total_users,
    }


@router.delete("/users/{user_id}")
async def delete_user(user_id: str, db: AsyncSession = Depends(get_db)):
    """Delete a user and their Agent from the shared OpenClaw instance."""
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    # Delete Agent from shared OpenClaw instance using openclaw_agent_id
    agent_record = (await db.execute(
        select(UserAgent).where(UserAgent.user_id == user_id, UserAgent.is_default == True)
    )).scalar_one_or_none()
    if agent_record:
        await _delete_agent_by_openclaw_id(agent_record.openclaw_agent_id)

    # Delete usage records
    await db.execute(delete(UsageRecord).where(UsageRecord.user_id == user_id))

    # Delete user
    await db.delete(user)
    await db.commit()

    return {"ok": True}


@router.delete("/users/{user_id}/container")
async def delete_user_container(user_id: str, db: AsyncSession = Depends(get_db)):
    """Stop and remove a user's sandbox container (data is preserved)."""
    # Look up openclaw_agent_id
    agent_record = (await db.execute(
        select(UserAgent).where(UserAgent.user_id == user_id, UserAgent.is_default == True)
    )).scalar_one_or_none()
    if agent_record is None:
        raise HTTPException(status_code=404, detail="No agent found for user")
    openclaw_agent_id = agent_record.openclaw_agent_id

    if settings.dev_openclaw_url:
        bridge_url = settings.dev_openclaw_url
    else:
        container_info = await ensure_shared_container()
        bridge_url = f"http://{container_info['internal_host']}:{container_info['internal_port']}"

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.delete(
                f"{bridge_url}/api/agents/{openclaw_agent_id}/container",
            )
            if resp.status_code == 200:
                return resp.json()
            elif resp.status_code == 404:
                raise HTTPException(status_code=404, detail="Container not found")
            else:
                raise HTTPException(status_code=resp.status_code, detail=resp.json().get("detail", "Unknown error"))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/user-agents")
async def list_all_user_agents(db: AsyncSession = Depends(get_db)):
    """List all user-agent mappings (for bridge to enrich agent data)."""
    result = await db.execute(
        select(UserAgent).where(UserAgent.status == "active")
    )
    agents = result.scalars().all()
    return [
        {
            "id": a.id,
            "user_id": a.user_id,
            "openclaw_agent_id": a.openclaw_agent_id,
            "name": a.name,
        }
        for a in agents
    ]


# ---------------------------------------------------------------------------
# Platform config (admin-only)
# ---------------------------------------------------------------------------

class PlatformConfigResponse(BaseModel):
    max_agents_per_user: int


class PlatformConfigUpdate(BaseModel):
    max_agents_per_user: int | None = None


@router.get("/config", response_model=PlatformConfigResponse)
async def get_platform_config():
    """Get current platform configuration."""
    return PlatformConfigResponse(max_agents_per_user=settings.max_agents_per_user)


@router.put("/config", response_model=PlatformConfigResponse)
async def update_platform_config(body: PlatformConfigUpdate):
    """Update platform configuration (runtime override, resets on restart)."""
    if body.max_agents_per_user is not None:
        if body.max_agents_per_user < 1:
            raise HTTPException(status_code=400, detail="max_agents_per_user must be >= 1")
        settings.max_agents_per_user = body.max_agents_per_user
    return PlatformConfigResponse(max_agents_per_user=settings.max_agents_per_user)


# ---------------------------------------------------------------------------
# Tier management
# ---------------------------------------------------------------------------


class TierInfo(BaseModel):
    name: str
    backend: str
    max_agents: int | None
    max_sessions_per_agent: int | None
    features: dict[str, bool]
    quota_daily_tokens: int | None


@router.get("/tiers", response_model=list[TierInfo])
async def list_tiers():
    """List all available tiers with their configuration."""
    from app.agentcore.config.tiers import TierConfigManager

    tm = TierConfigManager()
    tiers = []
    for name, cfg in tm.get_all_tiers().items():
        daily_tokens = None
        if cfg.quota:
            daily_tokens = cfg.quota.get("daily_tokens")
        tiers.append(TierInfo(
            name=name,
            backend=cfg.backend,
            max_agents=cfg.max_agents,
            max_sessions_per_agent=cfg.max_sessions_per_agent,
            features=cfg.features or {},
            quota_daily_tokens=daily_tokens,
        ))
    return tiers


# ---------------------------------------------------------------------------
# Tier migration
# ---------------------------------------------------------------------------


class MigrateUserRequest(BaseModel):
    direction: str  # "upgrade" or "downgrade"


class MigrationStatusResponse(BaseModel):
    id: str
    user_id: str
    direction: str
    from_tier: str
    to_tier: str
    status: str
    error: str | None = None
    created_at: datetime
    completed_at: datetime | None = None
    steps: list[dict[str, str]] = []


@router.post("/users/{user_id}/migrate", response_model=MigrationStatusResponse)
async def migrate_user_tier(
    user_id: str,
    req: MigrateUserRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    Trigger a tier migration for a user.

    This is a potentially long-running operation (seconds to minutes).
    Returns immediately with a migration ID; use GET /admin/migrations/{id} to track progress.
    """
    from app.agentcore.config.tiers import TierConfigManager
    from app.agentcore.migration import TierMigrationService, MigrationRecord, MigrationStatus
    from app.agentcore.router import get_router
    from app.container.dedicated_manager import get_container_manager
    from app.db.models import User
    from sqlalchemy import select

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    tm = TierConfigManager()
    current_tier = user.quota_tier
    target_tier = req.direction

    # Validate direction
    if req.direction == "upgrade":
        if current_tier in ("pro", "enterprise"):
            raise HTTPException(status_code=400, detail=f"User is already {current_tier}")
        target_tier_name = "pro" if current_tier in ("free", "basic") else "enterprise"
    elif req.direction == "downgrade":
        if current_tier not in ("pro", "enterprise"):
            raise HTTPException(status_code=400, detail=f"User is already {current_tier}")
        target_tier_name = "free"
    else:
        raise HTTPException(status_code=400, detail=f"Invalid direction: {req.direction}")

    router = get_router()
    cm = get_container_manager()

    service = TierMigrationService(
        container_manager=cm,
        shared_adapter=router._shared_adapter,
    )

    try:
        migration_id = service.gen_id()
        record = MigrationRecord(
            id=migration_id,
            user_id=user_id,
            direction=req.direction,
            from_tier=current_tier,
            to_tier=target_tier_name,
            status=MigrationStatus.PENDING,
        )
        await service.save_record(record)

        async def _run():
            try:
                if req.direction == "upgrade":
                    await service.upgrade(user_id, record)
                else:
                    await service.downgrade(user_id, record)
            except Exception as e:
                logger.error("Migration %s failed for user %s: %s", migration_id, user_id, e)

        asyncio.create_task(_run())

        return MigrationStatusResponse(
            id=record.id,
            user_id=record.user_id,
            direction=record.direction,
            from_tier=record.from_tier,
            to_tier=record.to_tier,
            status=record.status.value,
            error=None,
            created_at=record.created_at,
            completed_at=None,
            steps=[],
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/migrations/{migration_id}", response_model=MigrationStatusResponse)
async def get_migration_status(migration_id: str, db: AsyncSession = Depends(get_db)):
    """Get the status of a migration."""
    from sqlalchemy import text

    result = await db.execute(
        text("SELECT * FROM tier_migrations WHERE id = :id"),
        {"id": migration_id},
    )
    row = result.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Migration not found")
    import json
    steps_raw = row.get("steps")
    steps: list[dict[str, str]] = []
    if steps_raw:
        try:
            steps = json.loads(steps_raw)
        except Exception:
            pass
    return MigrationStatusResponse(
        id=row["id"],
        user_id=row["user_id"],
        direction=row["direction"],
        from_tier=row["from_tier"],
        to_tier=row["to_tier"],
        status=row["status"],
        error=row.get("error"),
        created_at=row["created_at"],
        completed_at=row.get("completed_at"),
        steps=steps,
    )


@router.get("/users/{user_id}/migrations", response_model=list[MigrationStatusResponse])
async def list_user_migrations(user_id: str, db: AsyncSession = Depends(get_db)):
    """List all migrations for a user."""
    from sqlalchemy import text

    result = await db.execute(
        text("SELECT * FROM tier_migrations WHERE user_id = :uid ORDER BY created_at DESC"),
        {"uid": user_id},
    )
    rows = result.mappings().all()
    import json
    def _parse_row(row):
        steps_raw = row.get("steps")
        steps: list[dict[str, str]] = []
        if steps_raw:
            try:
                steps = json.loads(steps_raw)
            except Exception:
                pass
        return MigrationStatusResponse(
            id=row["id"],
            user_id=row["user_id"],
            direction=row["direction"],
            from_tier=row["from_tier"],
            to_tier=row["to_tier"],
            status=row["status"],
            error=row.get("error"),
            created_at=row["created_at"],
            completed_at=row.get("completed_at"),
            steps=steps,
        )
    return [_parse_row(row) for row in rows]
