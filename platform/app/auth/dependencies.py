"""FastAPI dependencies for authentication."""

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.service import decode_token, get_user_by_id
from app.config import settings
from app.db.engine import get_db
from app.db.models import Container, User

security = HTTPBearer()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Extract and validate the JWT from the Authorization header."""
    payload = decode_token(credentials.credentials)
    if payload is None or payload.get("type") != "access":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

    user = await get_user_by_id(db, payload["sub"])
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or disabled")
    return user


async def get_user_flexible(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Authenticate via JWT (web UI) or container_token (bridge/agent).

    This allows both the frontend and container-side agents to access
    the same endpoints.
    """
    token = credentials.credentials

    # Try JWT first
    payload = decode_token(token)
    if payload is not None and payload.get("type") == "access":
        user = await get_user_by_id(db, payload["sub"])
        if user is not None and user.is_active:
            return user

    # Fallback: try container_token (per-agent, not per-user)
    container = (await db.execute(
        select(Container).where(Container.container_token == token)
    )).scalar_one_or_none()
    if container is not None:
        # Check token expiration
        if container.is_token_expired():
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Container token has expired, please re-authenticate"
            )
        # Find user through UserAgent (agent_id -> UserAgent -> user_id)
        from app.db.models import UserAgent
        user_agent = (await db.execute(
            select(UserAgent).where(UserAgent.openclaw_agent_id == container.agent_id)
        )).scalar_one_or_none()
        if user_agent:
            user = await get_user_by_id(db, user_agent.user_id)
            if user is not None and user.is_active:
                return user

    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")


async def require_admin(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Require the current user to have admin role.

    Also allows bridge-to-platform communication using bridge_token.
    """
    token = credentials.credentials

    # Try JWT first
    payload = decode_token(token)
    if payload is not None and payload.get("type") == "access":
        user = await get_user_by_id(db, payload["sub"])
        if user is not None and user.is_active and user.role == "admin":
            return user

    # Fallback: bridge/proxy token for service-to-service communication
    from app.config import settings
    if token == settings.bridge_token or token == settings.proxy_token:
        # Return a virtual admin user for bridge requests
        return User(
            id="bridge",
            username="bridge",
            email="bridge@internal",
            role="admin",
            is_active=True,
        )

    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
