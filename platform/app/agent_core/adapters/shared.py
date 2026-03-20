"""SharedOpenClawAdapter — wraps existing bridge HTTP API as IAgentCore.

This adapter implements IAgentCore by delegating to the existing bridge
routes. No bridge code is modified; we simply add a typed wrapper around
the HTTP calls already made in routes/agents.py, routes/proxy.py, etc.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import httpx

from app.agent_core.interfaces import (
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


def _sign_agent_id(agent_id: str) -> str:
    """Sign agentId to prevent tampering (mirrors proxy.py)."""
    message = f"{agent_id}:{settings.bridge_token}"
    return hmac.new(
        settings.bridge_token.encode(),
        message.encode(),
        hashlib.sha256,
    ).hexdigest()[:16]


def _sign_is_admin(agent_id: str, is_admin: bool) -> str:
    """Sign isAdmin parameter (mirrors proxy.py)."""
    admin_str = "true" if is_admin else "false"
    message = f"{agent_id}:{admin_str}:{settings.bridge_token}"
    return hmac.new(
        settings.bridge_token.encode(),
        message.encode(),
        hashlib.sha256,
    ).hexdigest()[:16]


def _bridge_headers(agent_id: str, is_admin: bool = False) -> dict[str, str]:
    """Build standard bridge request headers."""
    return {
        "X-Agent-Id": agent_id,
        "X-Agent-Id-Sig": _sign_agent_id(agent_id),
        "X-Is-Admin": "true" if is_admin else "false",
    }


class SharedOpenClawAdapter(IAgentCore):
    """
    IAgentCore implementation for the shared OpenClaw instance.

    Reuses the existing bridge HTTP API from routes/proxy.py.
    Single shared instance for all users; agent isolation via X-Agent-Id header.
    """

    backend_type = BackendType.SHARED_OPENCLAW
    instance_id = "shared-openclaw-1"

    def __init__(self) -> None:
        self._http: httpx.AsyncClient | None = None

    @property
    def _client(self) -> httpx.AsyncClient:
        """Lazy HTTP client (created on first use to allow lifespan startup)."""
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=120.0)
        return self._http

    async def close(self) -> None:
        """Close the HTTP client."""
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    # -------------------------------------------------------------------------
    # Bridge URL resolution
    # -------------------------------------------------------------------------

    async def _get_bridge_url(self) -> str:
        """Get the bridge HTTP URL for the shared OpenClaw instance."""
        # Import here to avoid circular import at module level
        from app.container.shared_manager import ensure_shared_container

        if settings.dev_openclaw_url:
            return settings.dev_openclaw_url
        container_info = await ensure_shared_container()
        return f"http://{container_info['internal_host']}:{container_info['internal_port']}"

    async def _bridge_ws_url(self, agent_id: str, is_admin: bool = False) -> str:
        """Build the WebSocket proxy URL with auth parameters."""
        from app.container.shared_manager import ensure_shared_container

        if settings.dev_gateway_url:
            base = settings.dev_gateway_url
        elif settings.dev_openclaw_url:
            base = settings.dev_openclaw_url.replace("http://", "ws://").replace(
                "https://", "wss://"
            )
            if not base.endswith("/ws"):
                base = base.rstrip("/") + "/ws"
        else:
            container_info = await ensure_shared_container()
            base = f"ws://{container_info['internal_host']}:18080/ws"

        is_admin_sig = _sign_is_admin(agent_id, is_admin)
        sep = "&" if "?" in base else "?"
        return f"{base}{sep}agentId={agent_id}&isAdmin={is_admin}&isAdminSig={is_admin_sig}"

    # -------------------------------------------------------------------------
    # Event normalization
    # -------------------------------------------------------------------------

    def _normalize_event(self, raw: dict[str, Any]) -> CoreEvent:
        """Convert a bridge WS event dict to a normalized CoreEvent."""
        event_name = raw.get("event", "")
        payload = raw.get("payload", {})

        # Map bridge event names to EventType
        event_type_map = {
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
            event_type=event_type_map.get(event_name, EventType.STREAMING),
            session_key=payload.get("sessionKey", ""),
            content=payload.get("content", ""),
            metadata=payload,
        )

    # -------------------------------------------------------------------------
    # Agent lifecycle
    # -------------------------------------------------------------------------

    async def create_agent(self, config: AgentConfig) -> str:
        """Create an agent on the shared OpenClaw instance."""
        from app.personas import load_agents_md, load_soul_md

        bridge_url = await self._get_bridge_url()

        # Step 1: Create the agent in OpenClaw
        resp = await self._client.post(
            f"{bridge_url}/api/agents",
            json={"name": config.name, "agentId": config.name},  # agentId may differ
            headers=_bridge_headers(config.name, is_admin=True),
        )
        if resp.status_code != 200:
            raise AgentCreationError(f"OpenClaw rejected agent creation: {resp.status_code} {resp.text}")

        data = resp.json()
        agent_id = data.get("id", config.name)

        # Step 2: Set SOUL.md for non-admin agents
        if config.personality:
            soul_resp = await self._client.put(
                f"{bridge_url}/api/agents/{agent_id}/files/SOUL.md",
                json={"content": config.personality},
                headers=_bridge_headers(agent_id, is_admin=True),
            )
            if soul_resp.status_code not in (200, 201):
                import logging
                logging.getLogger(__name__).warning(
                    "Failed to set SOUL.md for agent %s: %s",
                    agent_id,
                    soul_resp.text,
                )

        return agent_id

    async def delete_agent(self, agent_id: str) -> None:
        """Delete an agent from the shared OpenClaw instance."""
        bridge_url = await self._get_bridge_url()
        resp = await self._client.delete(
            f"{bridge_url}/api/agents/{agent_id}",
            params={"delete_files": "true"},
            headers=_bridge_headers(agent_id, is_admin=True),
        )
        if resp.status_code not in (200, 404):
            raise AgentDeletionError(f"Failed to delete agent {agent_id}: {resp.status_code}")

    async def get_agent_status(self, agent_id: str) -> AgentStatus:
        """Get agent status from the bridge."""
        bridge_url = await self._get_bridge_url()
        try:
            resp = await self._client.get(
                f"{bridge_url}/api/agents/{agent_id}/status",
                headers=_bridge_headers(agent_id),
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
        # Fallback: assume running if we can't reach bridge
        return AgentStatus(agent_id=agent_id, status="running", sandbox_status="running")

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
        """
        Send a message via WebSocket relay.

        If on_event is provided, events are streamed to the callback.
        Otherwise, this method collects all events and returns.
        """
        import asyncio
        import websockets

        scoped_session = f"agent:{agent_id}:{session_key}"
        ws_url = await self._bridge_ws_url(agent_id, is_admin=False)

        if on_event is None:
            # Blocking mode: collect all events and discard (caller doesn't stream)
            return

        # Streaming mode: connect WS and stream events
        try:
            async with websockets.connect(ws_url, origin="http://127.0.0.1:8080") as ws:
                # Send the chat message
                req = {
                    "type": "req",
                    "id": 1,
                    "method": "chat.send",
                    "params": {"sessionKey": scoped_session, "message": message},
                }
                await ws.send(json.dumps(req))

                # Stream events until done
                async for raw in ws:
                    try:
                        event_dict = json.loads(raw)
                        # Check for done / error signals
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
        """List all sessions for an agent."""
        bridge_url = await self._get_bridge_url()
        try:
            resp = await self._client.get(
                f"{bridge_url}/api/sessions",
                headers=_bridge_headers(agent_id),
                params={"agentId": agent_id},
                timeout=10.0,
            )
            if resp.status_code == 200:
                raw_sessions = resp.json()
                return [
                    Session(
                        session_key=s.get("sessionKey", ""),
                        created_at=datetime.fromisoformat(s.get("createdAt", "1970-01-01T00:00:00")),
                        last_active_at=datetime.fromisoformat(s.get("lastActiveAt", "1970-01-01T00:00:00")),
                        message_count=s.get("messageCount", 0),
                    )
                    for s in raw_sessions
                ]
        except httpx.RequestError:
            pass
        return []

    async def delete_session(self, agent_id: str, session_key: str) -> None:
        """Delete a specific session."""
        bridge_url = await self._get_bridge_url()
        scoped = f"agent:{agent_id}:{session_key}"
        await self._client.delete(
            f"{bridge_url}/api/sessions/{scoped}",
            headers=_bridge_headers(agent_id),
        )

    async def get_session_history(
        self, agent_id: str, session_key: str, limit: int | None = None
    ) -> list[dict[str, Any]]:
        """Get message history for a session."""
        bridge_url = await self._get_bridge_url()
        scoped = f"agent:{agent_id}:{session_key}"
        params: dict[str, Any] = {"sessionKey": scoped}
        if limit:
            params["limit"] = limit

        try:
            resp = await self._client.get(
                f"{bridge_url}/api/sessions/{scoped}/history",
                headers=_bridge_headers(agent_id),
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
        """Get the workspace path (mirrors bridge behavior)."""
        return Path.home() / ".openclaw" / f"workspace-{agent_id}"

    async def list_workspace_files(
        self, agent_id: str, path: str | None = None
    ) -> list[WorkspaceFile]:
        """List files in the agent workspace via bridge."""
        bridge_url = await self._get_bridge_url()
        params: dict[str, Any] = {}
        if path:
            params["path"] = path

        try:
            resp = await self._client.get(
                f"{bridge_url}/api/agents/{agent_id}/files",
                headers=_bridge_headers(agent_id),
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
        """Read a workspace file via bridge."""
        bridge_url = await self._get_bridge_url()
        resp = await self._client.get(
            f"{bridge_url}/api/agents/{agent_id}/files/{path}",
            headers=_bridge_headers(agent_id),
            timeout=30.0,
        )
        if resp.status_code == 200:
            return resp.content
        raise FileNotFoundError(f"File not found: {path}")

    async def write_workspace_file(
        self, agent_id: str, path: str, content: bytes
    ) -> None:
        """Write a workspace file via bridge."""
        bridge_url = await self._get_bridge_url()
        resp = await self._client.put(
            f"{bridge_url}/api/agents/{agent_id}/files/{path}",
            json={"content": content.decode("utf-8", errors="replace")},
            headers=_bridge_headers(agent_id),
            timeout=30.0,
        )
        if resp.status_code not in (200, 201):
            raise IOError(f"Failed to write file {path}: {resp.status_code}")

    async def delete_workspace_file(self, agent_id: str, path: str) -> None:
        """Delete a workspace file via bridge."""
        bridge_url = await self._get_bridge_url()
        await self._client.delete(
            f"{bridge_url}/api/agents/{agent_id}/files/{path}",
            headers=_bridge_headers(agent_id),
        )

    async def prune_sandbox(self, agent_id: str) -> None:
        """Trigger sandbox cleanup for an agent (bridge admin endpoint)."""
        bridge_url = await self._get_bridge_url()
        try:
            await self._client.post(
                f"{bridge_url}/api/agents/{agent_id}/prune",
                headers=_bridge_headers(agent_id, is_admin=True),
                timeout=10.0,
            )
        except httpx.RequestError:
            pass  # Non-critical; sandbox will auto-prune

    # -------------------------------------------------------------------------
    # Skills
    # -------------------------------------------------------------------------

    async def list_skills(self, agent_id: str) -> list[SkillInfo]:
        """List installed skills via bridge."""
        bridge_url = await self._get_bridge_url()
        try:
            resp = await self._client.get(
                f"{bridge_url}/api/skills",
                headers=_bridge_headers(agent_id),
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
        """Install a skill to an agent via bridge copy endpoint."""
        bridge_url = await self._get_bridge_url()
        resp = await self._client.post(
            f"{bridge_url}/api/skills/{skill_name}/copy",
            headers=_bridge_headers(agent_id, is_admin=True),
            timeout=30.0,
        )
        if resp.status_code not in (200, 201):
            raise SkillInstallError(f"Failed to install skill {skill_name}: {resp.status_code}")

    async def uninstall_skill(self, agent_id: str, skill_name: str) -> None:
        """Uninstall a skill from an agent."""
        bridge_url = await self._get_bridge_url()
        await self._client.delete(
            f"{bridge_url}/api/skills/{skill_name}",
            headers=_bridge_headers(agent_id),
        )

    # -------------------------------------------------------------------------
    # Resource & Health
    # -------------------------------------------------------------------------

    async def get_resource_usage(self, agent_id: str) -> ResourceUsage:
        """Get resource usage for an agent from bridge status."""
        bridge_url = await self._get_bridge_url()
        try:
            resp = await self._client.get(
                f"{bridge_url}/api/status",
                headers=_bridge_headers(agent_id, is_admin=True),
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
        """Return info about this shared instance."""
        return CoreInstanceInfo(
            instance_id=self.instance_id,
            backend_type=self.backend_type,
            version=settings.openclaw_image,
            max_agents=None,
            max_sandboxes=None,
        )

    async def health_check(self) -> bool:
        """Check if the shared bridge is reachable."""
        try:
            bridge_url = await self._get_bridge_url()
            resp = await self._client.get(f"{bridge_url}/status", timeout=5.0)
            return resp.status_code == 200
        except httpx.RequestError:
            return False


# -----------------------------------------------------------------------------
# Custom exceptions
# -----------------------------------------------------------------------------


class AgentCoreError(Exception):
    """Base exception for agent core operations."""


class AgentCreationError(AgentCoreError):
    """Raised when agent creation fails."""


class AgentDeletionError(AgentCoreError):
    """Raised when agent deletion fails."""


class SkillInstallError(AgentCoreError):
    """Raised when skill installation fails."""


class BackendUnavailableError(AgentCoreError):
    """Raised when the backend is unreachable."""
