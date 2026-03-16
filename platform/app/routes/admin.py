"""Admin API routes for user and system management."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

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


class UpdateUserRequest(BaseModel):
    role: str | None = None
    quota_tier: str | None = None
    is_active: bool | None = None


async def _delete_agent(user_id: str) -> bool:
    """Delete an Agent from the shared OpenClaw instance.

    Returns True if successful, False otherwise.
    """
    # Get shared container URL
    if settings.dev_openclaw_url:
        bridge_url = settings.dev_openclaw_url
    else:
        container_info = await ensure_shared_container()
        bridge_url = f"http://{container_info['internal_host']}:{container_info['internal_port']}"

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.delete(
                f"{bridge_url}/api/agents/{user_id}",
                params={"delete_files": "true"},
            )
            return resp.status_code == 200
    except Exception as e:
        print(f"[admin] Failed to delete agent for user {user_id}: {e}")
        return False


@router.get("/users", response_model=list[UserSummary])
async def list_users(db: AsyncSession = Depends(get_db)):
    """List all users with their usage stats and container status."""
    users = (await db.execute(select(User))).scalars().all()
    result = []

    # Get shared container info for status lookup
    container_info = await get_shared_container_info()

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

        if container_info.get('status') == 'running':
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.get(
                        f"http://{container_info['internal_host']}:{container_info['internal_port']}/api/agents/{u.id}/status"
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

    # Delete Agent from shared OpenClaw instance
    await _delete_agent(user_id)

    # Delete usage records
    await db.execute(delete(UsageRecord).where(UsageRecord.user_id == user_id))

    # Delete user
    await db.delete(user)
    await db.commit()

    return {"ok": True}


@router.delete("/users/{user_id}/container")
async def delete_user_container(user_id: str):
    """Stop and remove a user's sandbox container (data is preserved)."""
    if settings.dev_openclaw_url:
        bridge_url = settings.dev_openclaw_url
    else:
        container_info = await ensure_shared_container()
        bridge_url = f"http://{container_info['internal_host']}:{container_info['internal_port']}"

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.delete(
                f"{bridge_url}/api/agents/{user_id}/container",
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
