"""Agent management API routes - supports multiple agents per user."""

import httpx
from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_admin
from app.config import settings
from app.container.shared_manager import ensure_shared_container
from app.db.engine import get_db
from app.db.models import User, UserAgent

router = APIRouter(prefix="/api/agents", tags=["agents"])


# -----------------------------------------------------------------------------
# Request / Response schemas
# -----------------------------------------------------------------------------

class CreateAgentRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    description: str = Field(default="", max_length=512)


class AgentResponse(BaseModel):
    id: str
    openclaw_agent_id: str
    name: str
    description: str
    is_default: bool
    status: str
    created_at: str


class AgentListResponse(BaseModel):
    agents: list[AgentResponse]
    max_allowed: int
    current_count: int


# -----------------------------------------------------------------------------
# Constants
# -----------------------------------------------------------------------------

# Regular users can only create 1 agent, admins can create unlimited
MAX_AGENTS_PER_USER = 1


# -----------------------------------------------------------------------------
# Helper functions
# -----------------------------------------------------------------------------

def _sanitize_agent_name(name: str) -> str:
    """Sanitize agent name for use in openclaw agent id."""
    # Remove special chars, keep alphanumeric, hyphen, underscore
    return "".join(c for c in name if c.isalnum() or c in "-_").lower()[:30]


async def _create_agent_in_openclaw(
    openclaw_agent_id: str,
    name: str,
    soul_md: str = "",
) -> bool:
    """Create an agent in the shared OpenClaw instance.

    Returns True if successful.
    """
    if settings.dev_openclaw_url:
        bridge_url = settings.dev_openclaw_url
    else:
        container_info = await ensure_shared_container()
        bridge_url = f"http://{container_info['internal_host']}:{container_info['internal_port']}"

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Create the agent
            resp = await client.post(
                f"{bridge_url}/api/agents",
                json={
                    "name": name,
                    "agentId": openclaw_agent_id,
                },
                headers={"X-Is-Admin": "true"},
            )
            if resp.status_code != 200:
                print(f"[agents] Failed to create agent in OpenClaw: {resp.status_code} - {resp.text}")
                return False

            # Set SOUL.md if provided
            if soul_md:
                soul_resp = await client.put(
                    f"{bridge_url}/api/agents/{openclaw_agent_id}/files/SOUL.md",
                    json={"content": soul_md},
                    headers={"X-Agent-Id": openclaw_agent_id, "X-Is-Admin": "true"},
                )
                if soul_resp.status_code != 200:
                    print(f"[agents] Warning: Failed to set SOUL.md for agent {openclaw_agent_id}")

            return True
    except Exception as e:
        print(f"[agents] Failed to create agent in OpenClaw: {e}")
        return False


async def _delete_agent_in_openclaw(openclaw_agent_id: str, delete_files: bool = True) -> bool:
    """Delete an agent from the shared OpenClaw instance."""
    if settings.dev_openclaw_url:
        bridge_url = settings.dev_openclaw_url
    else:
        container_info = await ensure_shared_container()
        bridge_url = f"http://{container_info['internal_host']}:{container_info['internal_port']}"

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.delete(
                f"{bridge_url}/api/agents/{openclaw_agent_id}",
                params={"delete_files": "true" if delete_files else "false"},
                headers={"X-Is-Admin": "true"},
            )
            return resp.status_code == 200
    except Exception as e:
        print(f"[agents] Failed to delete agent in OpenClaw: {e}")
        return False


# -----------------------------------------------------------------------------
# Endpoints
# -----------------------------------------------------------------------------

@router.get("", response_model=AgentListResponse)
async def list_agents(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all agents for the current user."""
    result = await db.execute(
        select(UserAgent).where(
            UserAgent.user_id == user.id,
            UserAgent.status == "active",
        ).order_by(UserAgent.created_at)
    )
    agents = result.scalars().all()

    max_allowed = float('inf') if user.role == "admin" else MAX_AGENTS_PER_USER

    return AgentListResponse(
        agents=[
            AgentResponse(
                id=a.id,
                openclaw_agent_id=a.openclaw_agent_id,
                name=a.name,
                description=a.description,
                is_default=a.is_default,
                status=a.status,
                created_at=a.created_at.isoformat(),
            )
            for a in agents
        ],
        max_allowed=max_allowed if max_allowed != float('inf') else -1,
        current_count=len(agents),
    )


@router.post("", response_model=AgentResponse, status_code=status.HTTP_201_CREATED)
async def create_agent(
    req: CreateAgentRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a new agent for the current user.

    Regular users can only create 1 agent. Admins can create unlimited.
    """
    # Check agent limit for non-admin users
    if user.role != "admin":
        result = await db.execute(
            select(func.count(UserAgent.id)).where(
                UserAgent.user_id == user.id,
                UserAgent.status == "active",
            )
        )
        current_count = result.scalar_one()
        if current_count >= MAX_AGENTS_PER_USER:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"You can only have {MAX_AGENTS_PER_USER} active agent(s). Please delete an existing agent first.",
            )

    # Generate openclaw agent id: user_id + random suffix to ensure uniqueness
    import uuid
    suffix = str(uuid.uuid4())[:8]
    safe_name = _sanitize_agent_name(req.name)
    openclaw_agent_id = f"{user.id}-{safe_name}-{suffix}"

    # Check if this is the first agent (set as default)
    result = await db.execute(
        select(func.count(UserAgent.id)).where(
            UserAgent.user_id == user.id,
            UserAgent.status == "active",
        )
    )
    is_first = result.scalar_one() == 0

    # Create agent in OpenClaw first
    created = await _create_agent_in_openclaw(
        openclaw_agent_id=openclaw_agent_id,
        name=req.name,
    )
    if not created:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create agent in OpenClaw",
        )

    # Create agent record in database
    agent = UserAgent(
        user_id=user.id,
        openclaw_agent_id=openclaw_agent_id,
        name=req.name,
        description=req.description,
        is_default=is_first,  # First agent is default
    )
    db.add(agent)
    await db.commit()
    await db.refresh(agent)

    return AgentResponse(
        id=agent.id,
        openclaw_agent_id=agent.openclaw_agent_id,
        name=agent.name,
        description=agent.description,
        is_default=agent.is_default,
        status=agent.status,
        created_at=agent.created_at.isoformat(),
    )


@router.delete("/{agent_id}")
async def delete_agent(
    agent_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete an agent (soft delete, archives it)."""
    result = await db.execute(
        select(UserAgent).where(
            UserAgent.id == agent_id,
            UserAgent.user_id == user.id,
            UserAgent.status == "active",
        )
    )
    agent = result.scalar_one_or_none()

    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    # Delete from OpenClaw
    deleted = await _delete_agent_in_openclaw(agent.openclaw_agent_id, delete_files=True)
    if not deleted:
        # Continue with soft delete even if OpenClaw delete fails
        print(f"[agents] Warning: Failed to delete agent {agent.openclaw_agent_id} from OpenClaw")

    # Soft delete - mark as archived
    agent.status = "archived"
    await db.commit()

    # If this was the default agent, set another active agent as default
    if agent.is_default:
        result = await db.execute(
            select(UserAgent).where(
                UserAgent.user_id == user.id,
                UserAgent.status == "active",
            ).order_by(UserAgent.created_at)
        )
        next_agent = result.scalars().first()
        if next_agent:
            next_agent.is_default = True
            await db.commit()

    return {"ok": True, "message": "Agent deleted"}


@router.post("/{agent_id}/set-default")
async def set_default_agent(
    agent_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Set an agent as the default agent for the user."""
    # First, unset current default
    await db.execute(
        select(UserAgent).where(
            UserAgent.user_id == user.id,
            UserAgent.is_default == True,
        )
    )
    result = await db.execute(
        select(UserAgent).where(UserAgent.user_id == user.id, UserAgent.is_default == True)
    )
    current_default = result.scalar_one_or_none()
    if current_default:
        current_default.is_default = False

    # Set new default
    result = await db.execute(
        select(UserAgent).where(
            UserAgent.id == agent_id,
            UserAgent.user_id == user.id,
            UserAgent.status == "active",
        )
    )
    agent = result.scalar_one_or_none()

    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    agent.is_default = True
    await db.commit()

    return {"ok": True, "message": "Default agent updated"}


@router.get("/{agent_id}", response_model=AgentResponse)
async def get_agent(
    agent_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get a specific agent's details."""
    result = await db.execute(
        select(UserAgent).where(
            UserAgent.id == agent_id,
            UserAgent.user_id == user.id,
        )
    )
    agent = result.scalar_one_or_none()

    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    return AgentResponse(
        id=agent.id,
        openclaw_agent_id=agent.openclaw_agent_id,
        name=agent.name,
        description=agent.description,
        is_default=agent.is_default,
        status=agent.status,
        created_at=agent.created_at.isoformat(),
    )
