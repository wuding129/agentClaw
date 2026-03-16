"""Request routing — reverse-proxy from gateway to shared openclaw instance.

In multi-agent architecture, all users share a single OpenClaw Gateway instance.
Requests are routed to the shared instance with agentId for multi-agent isolation.
"""

from __future__ import annotations

import hashlib
import hmac
import httpx
import logging
from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.config import settings
from app.container.shared_manager import ensure_shared_container
from app.db.engine import async_session, get_db
from app.db.models import User, UserAgent
from sqlalchemy import select

logger = logging.getLogger(__name__)


async def _get_default_agent(db: AsyncSession, user_id: str) -> UserAgent | None:
    """Get the user's default agent."""
    result = await db.execute(
        select(UserAgent).where(
            UserAgent.user_id == user_id,
            UserAgent.is_default == True,
            UserAgent.status == "active",
        )
    )
    return result.scalar_one_or_none()


def _sign_is_admin(agent_id: str, is_admin: bool) -> str:
    """Sign isAdmin parameter to prevent tampering.

    Bridge will verify this signature to ensure isAdmin came from Platform Gateway.
    """
    # Use lowercase string for consistent verification
    admin_str = "true" if is_admin else "false"
    message = f"{agent_id}:{admin_str}:{settings.bridge_token}"
    return hmac.new(
        settings.bridge_token.encode(),
        message.encode(),
        hashlib.sha256,
    ).hexdigest()[:16]


def _sign_agent_id(agent_id: str) -> str:
    """Sign agentId to prevent tampering.

    Bridge will verify this signature to ensure agentId came from Platform Gateway.
    """
    message = f"{agent_id}:{settings.bridge_token}"
    return hmac.new(
        settings.bridge_token.encode(),
        message.encode(),
        hashlib.sha256,
    ).hexdigest()[:16]

router = APIRouter(prefix="/api/openclaw", tags=["proxy"])

# Paths that require admin role
ADMIN_ONLY_PATHS = [
    "channels",       # Channel management
    "models/config",  # Model configuration
    "nodes",          # Node management
    "cron",           # Cron jobs
]


async def _shared_instance_url() -> str:
    """Get the URL for the shared OpenClaw instance."""
    # Local dev mode: bypass Docker, forward to local openclaw directly
    if settings.dev_openclaw_url:
        return settings.dev_openclaw_url
    container_info = await ensure_shared_container()
    return f"http://{container_info['internal_host']}:{container_info['internal_port']}"


# ---------------------------------------------------------------------------
# HTTP reverse proxy  (catch-all for /api/openclaw/{path})
# ---------------------------------------------------------------------------

@router.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy_http(
    path: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Forward HTTP requests to the shared openclaw instance with agent routing."""
    # Check admin-only paths for non-admin users
    if user.role != "admin":
        for admin_path in ADMIN_ONLY_PATHS:
            if path.startswith(admin_path):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Admin access required",
                )

    # Get user's default agent for routing
    user_agent = await _get_default_agent(db, user.id)
    if user_agent is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No default agent found. Please create an agent first.",
        )
    agent_id = user_agent.openclaw_agent_id

    base_url = await _shared_instance_url()
    # Close the session explicitly so the connection returns to the pool
    # before the potentially long upstream call (up to 120s).
    await db.close()

    target_url = f"{base_url}/api/{path}"

    # Forward query params
    if request.query_params:
        target_url += f"?{request.query_params}"

    body = await request.body()

    # Forward Authorization header if present
    auth_header = request.headers.get("authorization")

    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            resp = await client.request(
                method=request.method,
                url=target_url,
                content=body,
                headers={
                    "content-type": request.headers.get("content-type", "application/json"),
                    # Add agentId header for multi-agent routing (use openclaw_agent_id)
                    "X-Agent-Id": agent_id,
                    # Sign agentId to prevent tampering
                    "X-Agent-Id-Sig": _sign_agent_id(agent_id),
                    # Add admin flag for admin users
                    "X-Is-Admin": "true" if user.role == "admin" else "false",
                    # Forward authorization header for bridge authentication
                    **({"Authorization": auth_header} if auth_header else {}),
                },
            )
        except httpx.ConnectError:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="OpenClaw instance is starting up, please retry in a few seconds",
            )

    from fastapi.responses import Response
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "application/json"),
        headers={k: v for k, v in resp.headers.items() if k.lower() in ("content-disposition",)},
    )


# ---------------------------------------------------------------------------
# WebSocket reverse proxy
# ---------------------------------------------------------------------------

@router.websocket("/ws")
async def proxy_websocket(
    websocket: WebSocket,
    token: str = "",  # passed as query param ?token=xxx
):
    """Forward WebSocket connections to shared OpenClaw Gateway with agent routing."""
    from app.auth.service import decode_token, get_user_by_id

    # Accept first, then authenticate and close if invalid
    await websocket.accept()

    # Authenticate, then release DB session immediately
    async with async_session() as db:
        payload = decode_token(token)
        if payload is None or payload.get("type") != "access":
            await websocket.close(code=4001, reason="Invalid token")
            return

        user = await get_user_by_id(db, payload["sub"])
        if user is None or not user.is_active:
            await websocket.close(code=4001, reason="User not found")
            return

        # Get user's default agent for routing
        user_agent = await _get_default_agent(db, user.id)
        if user_agent is None:
            await websocket.close(code=4001, reason="No default agent found")
            return

        # Store info for agent routing
        agent_id = user_agent.openclaw_agent_id
        is_admin = user.role == "admin"

        if settings.dev_gateway_url:
            target_ws_url = settings.dev_gateway_url
        elif settings.dev_openclaw_url:
            # Fallback: derive gateway URL from openclaw URL
            target_ws_url = settings.dev_openclaw_url.replace("http://", "ws://").replace("https://", "wss://")
            if not target_ws_url.endswith("/ws"):
                target_ws_url = target_ws_url.rstrip("/") + "/ws"
        else:
            # Use shared container
            container_info = await ensure_shared_container()
            # Connect to bridge WS relay (port 18080), not gateway directly
            target_ws_url = f"ws://{container_info['internal_host']}:18080/ws"

        # Add agentId and isAdmin query parameters for multi-agent routing
        # Sign isAdmin to prevent tampering
        admin_param = "true" if is_admin else "false"
        is_admin_sig = _sign_is_admin(agent_id, is_admin)
        sep = "&" if "?" in target_ws_url else "?"
        target_ws_url = f"{target_ws_url}{sep}agentId={agent_id}&isAdmin={admin_param}&isAdminSig={is_admin_sig}"
    # DB session is now released — not held during long-lived WebSocket relay

    import asyncio
    import websockets

    try:
        # Retry connection — container gateway may still be starting
        upstream = None
        for _attempt in range(10):
            try:
                upstream = await websockets.connect(target_ws_url, origin="http://127.0.0.1:8080")
                break
            except (ConnectionRefusedError, OSError):
                if _attempt < 9:
                    await asyncio.sleep(2)
        if upstream is None:
            await websocket.close(code=1013, reason="Container gateway not ready")
            return

        # Track last activity for ping/pong
        last_activity = asyncio.get_event_loop().time()

        async def client_to_upstream():
            nonlocal last_activity
            try:
                while True:
                    data = await websocket.receive_text()
                    last_activity = asyncio.get_event_loop().time()
                    await upstream.send(data)
            except (WebSocketDisconnect, Exception):
                pass

        async def upstream_to_client():
            nonlocal last_activity
            try:
                async for message in upstream:
                    last_activity = asyncio.get_event_loop().time()
                    try:
                        await websocket.send_text(message)
                    except RuntimeError:
                        break
            except websockets.ConnectionClosed:
                pass

        # Track last pong time for connection health check
        last_pong = asyncio.get_event_loop().time()

        async def keepalive():
            """Send periodic pings and verify pong responses to detect dead connections."""
            nonlocal last_activity, last_pong
            pong_timeout = 10  # seconds to wait for pong response
            max_idle_time = 120  # max seconds without any activity before forcing close

            while True:
                try:
                    await asyncio.sleep(30)
                    now = asyncio.get_event_loop().time()

                    # Check if connection has been idle too long (no data in either direction)
                    if now - last_activity >= max_idle_time:
                        logger.warning("[ws-proxy] Connection idle for %ds, closing", max_idle_time)
                        break

                    # If no activity for 30 seconds, send a ping and wait for pong
                    if now - last_activity >= 30:
                        try:
                            # Send ping and wait for pong with timeout
                            pong_waiter = await upstream.ping()
                            await asyncio.wait_for(pong_waiter, timeout=pong_timeout)
                            last_pong = asyncio.get_event_loop().time()
                            logger.debug("[ws-proxy] Pong received, connection healthy")
                        except asyncio.TimeoutError:
                            logger.error("[ws-proxy] Pong timeout after %ds, connection dead", pong_timeout)
                            break
                        except Exception as e:
                            logger.error("[ws-proxy] Ping failed: %s", e)
                            break
                except asyncio.CancelledError:
                    break
                except Exception as e:
                    logger.error("[ws-proxy] Keepalive error: %s", e)
                    break

        tasks = [
            asyncio.create_task(client_to_upstream()),
            asyncio.create_task(upstream_to_client()),
            asyncio.create_task(keepalive()),
        ]
        try:
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
        finally:
            await upstream.close()

    except Exception as exc:
        import traceback
        print(f"[ws-proxy] Error: {exc}\n{traceback.format_exc()}", flush=True)
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
