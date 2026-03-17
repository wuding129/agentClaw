"""Authentication API routes."""

import httpx
from pydantic import BaseModel, EmailStr
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.service import (
    authenticate_user,
    create_access_token,
    create_api_token,
    create_refresh_token,
    create_user,
    decode_token,
    get_user_by_email,
    get_user_by_id,
    get_user_by_username,
    update_password,
    verify_password,
)
from app.auth.dependencies import get_current_user
from app.config import settings
from app.container.shared_manager import ensure_shared_container
from app.db.engine import get_db
from app.db.models import User, UserAgent
from app.personas import load_soul_md

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _sanitize_agent_name(name: str) -> str:
    """Sanitize agent name for use in openclaw agent id."""
    return "".join(c for c in name if c.isalnum() or c in "-_").lower()[:30]


async def _create_default_agent_for_user(
    db: AsyncSession,
    user_id: str,
    username: str,
    is_admin: bool = False,
) -> UserAgent | None:
    """Create the default Agent for a new user.

    This creates both the UserAgent record in the database and the agent
    in the shared OpenClaw instance.

    Returns the created UserAgent or None if failed.
    """
    import uuid

    # Get shared container URL
    if settings.dev_openclaw_url:
        bridge_url = settings.dev_openclaw_url
    else:
        container_info = await ensure_shared_container()
        bridge_url = f"http://{container_info['internal_host']}:{container_info['internal_port']}"

    # Generate openclaw agent id
    safe_username = _sanitize_agent_name(username)
    suffix = str(uuid.uuid4())[:8]
    openclaw_agent_id = f"{user_id}-{safe_username}-{suffix}"

    # Agent display name
    agent_name = f"{username}'s Agent"

    # Create agent in OpenClaw first
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{bridge_url}/api/agents",
                json={"name": agent_name, "agentId": openclaw_agent_id},
                headers={"X-Is-Admin": "true"},
            )
            if resp.status_code != 200:
                print(f"[auth] Failed to create agent in OpenClaw for {user_id}: {resp.status_code} - {resp.text}")
                return None

            # For regular users, set the AgentClaw SOUL.md
            if not is_admin:
                soul_resp = await client.put(
                    f"{bridge_url}/api/agents/{openclaw_agent_id}/files/SOUL.md",
                    json={"content": load_soul_md()},
                    headers={"X-Agent-Id": openclaw_agent_id, "X-Is-Admin": "true"},
                )
                if soul_resp.status_code != 200:
                    print(f"[auth] Warning: Failed to set SOUL.md for agent {openclaw_agent_id}")
    except Exception as e:
        print(f"[auth] Failed to create agent in OpenClaw for user {user_id}: {e}")
        return None

    # Create UserAgent record in database
    agent = UserAgent(
        user_id=user_id,
        openclaw_agent_id=openclaw_agent_id,
        name=agent_name,
        description="Your default agent",
        is_default=True,
        soul_md=load_soul_md() if not is_admin else "",
    )
    db.add(agent)
    await db.commit()
    await db.refresh(agent)

    return agent


async def _delete_agents_for_user(
    db: AsyncSession,
    user_id: str,
    delete_files: bool = True,
) -> bool:
    """Delete all agents for a user.

    This archives all UserAgent records and deletes them from OpenClaw.

    Returns True if successful.
    """
    from sqlalchemy import select

    # Get all active agents for the user
    result = await db.execute(
        select(UserAgent).where(
            UserAgent.user_id == user_id,
            UserAgent.status == "active",
        )
    )
    agents = result.scalars().all()

    # Get shared container URL
    if settings.dev_openclaw_url:
        bridge_url = settings.dev_openclaw_url
    else:
        container_info = await ensure_shared_container()
        bridge_url = f"http://{container_info['internal_host']}:{container_info['internal_port']}"

    success = True
    for agent in agents:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.delete(
                    f"{bridge_url}/api/agents/{agent.openclaw_agent_id}",
                    params={"delete_files": "true" if delete_files else "false"},
                    headers={"X-Is-Admin": "true"},
                )
                if resp.status_code != 200:
                    print(f"[auth] Failed to delete agent {agent.openclaw_agent_id} from OpenClaw: {resp.text}")
                    success = False

            # Archive the agent record
            agent.status = "archived"
        except Exception as e:
            print(f"[auth] Failed to delete agent {agent.openclaw_agent_id}: {e}")
            success = False

    await db.commit()
    return success


# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class RegisterRequest(BaseModel):
    username: str
    email: str
    password: str


class LoginRequest(BaseModel):
    username: str  # accepts username or email
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user_id: str
    username: str
    role: str


class RefreshRequest(BaseModel):
    refresh_token: str


class UserResponse(BaseModel):
    id: str
    username: str
    email: str
    role: str
    quota_tier: str
    is_active: bool


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(req: RegisterRequest, db: AsyncSession = Depends(get_db)):
    if await get_user_by_username(db, req.username):
        raise HTTPException(status_code=400, detail="Username already taken")
    if await get_user_by_email(db, req.email):
        raise HTTPException(status_code=400, detail="Email already registered")

    user = await create_user(db, req.username, req.email, req.password)

    # Create default Agent for the new user
    agent = await _create_default_agent_for_user(
        db, user.id, user.username, is_admin=(user.role == "admin")
    )
    if agent is None:
        raise HTTPException(status_code=500, detail="Failed to create agent")

    return TokenResponse(
        access_token=create_access_token(user.id, user.role),
        refresh_token=create_refresh_token(user.id),
        user_id=user.id,
        username=user.username,
        role=user.role,
    )


@router.post("/login", response_model=TokenResponse)
async def login(req: LoginRequest, db: AsyncSession = Depends(get_db)):
    user = await authenticate_user(db, req.username, req.password)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return TokenResponse(
        access_token=create_access_token(user.id, user.role),
        refresh_token=create_refresh_token(user.id),
        user_id=user.id,
        username=user.username,
        role=user.role,
    )


@router.post("/refresh", response_model=TokenResponse)
async def refresh(req: RefreshRequest, db: AsyncSession = Depends(get_db)):
    payload = decode_token(req.refresh_token)
    if payload is None or payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    user = await get_user_by_id(db, payload["sub"])
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or disabled")
    return TokenResponse(
        access_token=create_access_token(user.id, user.role),
        refresh_token=create_refresh_token(user.id),
        user_id=user.id,
        username=user.username,
        role=user.role,
    )


@router.get("/me", response_model=UserResponse)
async def get_me(user: User = Depends(get_current_user)):
    return UserResponse(
        id=user.id,
        username=user.username,
        email=user.email,
        role=user.role,
        quota_tier=user.quota_tier,
        is_active=user.is_active,
    )


class ApiTokenResponse(BaseModel):
    api_token: str
    expires_in_days: int = 365


@router.post("/api-token", response_model=ApiTokenResponse)
async def generate_api_token(user: User = Depends(get_current_user)):
    """Generate a long-lived API token for programmatic access."""
    token = create_api_token(user.id, user.role)
    return ApiTokenResponse(api_token=token)


class ChangepasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password")
async def change_password(
    req: ChangepasswordRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Change the current user's password."""
    # Verify current password
    if not verify_password(req.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    # Update password
    await update_password(db, user.id, req.new_password)

    return {"ok": True, "message": "password changed successfully"}
