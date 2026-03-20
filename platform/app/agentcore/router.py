"""AgentCoreRouter — unified routing layer for all agent backend operations.

Phase 0: All users route to shared OpenClaw.
Phase 1: Tier config wired to DB (quota_tier field).
Phase 2: Pro/Enterprise users route to dedicated containers.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, Callable

from app.agentcore.adapters import SharedOpenClawAdapter
from app.agentcore.config.tiers import TierConfigManager
from app.agentcore.interfaces import (
    AgentConfig,
    AgentStatus,
    BackendType,
    CoreEvent,
    CoreInstanceInfo,
    IAgentCore,
    ResourceUsage,
    Session,
    SkillInfo,
    WorkspaceFile,
)
from app.agentcore.config.tiers import TierConfig

if TYPE_CHECKING:
    from pathlib import Path


# -----------------------------------------------------------------------------
# Router singleton
# -----------------------------------------------------------------------------


class AgentCoreRouter:
    """
    Central routing layer for all agent core operations.

    Phase 0 behaviour:
        All users route to the shared SharedOpenClawAdapter.
        No changes to existing functionality.

    Future behaviour:
        Route based on user.tier:
            free/basic → SharedOpenClawAdapter (single shared instance)
            pro/enterprise → DedicatedOpenClawAdapter (per-user container)
        Additional adapters (ClaudeCodeAdapter, etc.) registered as plugins.
    """

    def __init__(
        self,
        tier_config: TierConfigManager | None = None,
    ) -> None:
        self._tier_config = tier_config or TierConfigManager()

        self._shared_adapter = SharedOpenClawAdapter()
        self._dedicated_adapters: dict[str, IAgentCore] = {}
        self._cm = None  # DedicatedContainerManager, lazy init

    def _get_cm(self):
        if self._cm is None:
            from app.container.dedicated_manager import get_container_manager
            self._cm = get_container_manager()
        return self._cm

    # -------------------------------------------------------------------------
    # Adapter resolution
    # -------------------------------------------------------------------------

    async def get_adapter(self, user_id: str) -> IAgentCore:
        """Resolve the IAgentCore adapter for a user based on their tier.

        free/basic → SharedOpenClawAdapter
        pro/enterprise → DedicatedOpenClawAdapter
        """
        tier_name = await self._get_user_tier(user_id)
        tier = self._tier_config.get_tier(tier_name)

        if tier.backend == "shared":
            return self._shared_adapter

        if user_id not in self._dedicated_adapters:
            await self._provision_dedicated(user_id, tier)

        return self._dedicated_adapters[user_id]

    async def _provision_dedicated(
        self, user_id: str, tier: TierConfig
    ) -> None:
        """Create and cache a dedicated adapter for a user."""
        from app.agentcore.adapters.dedicated import DedicatedOpenClawAdapter

        cm = self._get_cm()
        adapter = DedicatedOpenClawAdapter(user_id=user_id, container_manager=cm)
        await adapter.initialize()
        self._dedicated_adapters[user_id] = adapter

    async def get_adapter_for_agent(
        self, user_id: str, agent_id: str
    ) -> IAgentCore:
        """
        Get the adapter for a specific agent.
        Currently identical to get_adapter(user_id) but allows per-agent
        routing in future (e.g., mixed backends for the same user).
        """
        return await self.get_adapter(user_id)

    async def _get_user_tier(self, user_id: str) -> str:
        """
        Look up a user's quota tier from the database.

        Phase 0: Always returns 'free' (shared backend).
        Future: Reads user.quota_tier from DB.
        """
        # Defer import to avoid circular refs at module load
        from app.db.engine import async_session
        from app.db.models import User
        from sqlalchemy import select

        async with async_session() as db:
            result = await db.execute(select(User).where(User.id == user_id))
            user = result.scalar_one_or_none()
            if user is not None:
                return getattr(user, "quota_tier", "free")
        return "free"

    # -------------------------------------------------------------------------
    # Tier config shortcuts
    # -------------------------------------------------------------------------

    def get_tier_config(self, tier_name: str) -> TierConfig:
        """Get the tier configuration by name."""
        return self._tier_config.get_tier(tier_name)

    def get_user_tier_config(self, user_id: str) -> TierConfig:
        """Get the tier configuration for a user."""
        import asyncio
        tier_name = asyncio.get_event_loop().run_until_complete(
            self._get_user_tier(user_id)
        )
        return self._tier_config.get_tier(tier_name)

    def is_feature_enabled(self, user_id: str, feature: str) -> bool:
        """Check if a feature is enabled for a user based on their tier."""
        import asyncio
        tier_name = asyncio.get_event_loop().run_until_complete(
            self._get_user_tier(user_id)
        )
        return self._tier_config.is_feature_enabled(tier_name, feature)

    # -------------------------------------------------------------------------
    # Unified operation proxies — all platform routes go through here
    # -------------------------------------------------------------------------

    async def create_agent(self, user_id: str, config: AgentConfig) -> str:
        """Create an agent, routed to the appropriate backend."""
        adapter = await self.get_adapter(user_id)
        return await adapter.create_agent(config)

    async def delete_agent(self, user_id: str, agent_id: str) -> None:
        """Delete an agent from the appropriate backend."""
        adapter = await self.get_adapter(user_id)
        await adapter.delete_agent(agent_id)

    async def get_agent_status(
        self, user_id: str, agent_id: str
    ) -> AgentStatus:
        """Get agent status."""
        adapter = await self.get_adapter(user_id)
        return await adapter.get_agent_status(agent_id)

    async def send_message(
        self,
        user_id: str,
        agent_id: str,
        session_key: str,
        message: str,
        on_event: Callable[[CoreEvent], None] | None = None,
    ) -> None:
        """Send a message, routed to the appropriate backend."""
        adapter = await self.get_adapter(user_id)
        await adapter.send_message(agent_id, session_key, message, on_event)

    async def list_sessions(self, user_id: str, agent_id: str) -> list[Session]:
        """List sessions for an agent."""
        adapter = await self.get_adapter(user_id)
        return await adapter.list_sessions(agent_id)

    async def delete_session(
        self, user_id: str, agent_id: str, session_key: str
    ) -> None:
        """Delete a session."""
        adapter = await self.get_adapter(user_id)
        await adapter.delete_session(agent_id, session_key)

    async def get_session_history(
        self,
        user_id: str,
        agent_id: str,
        session_key: str,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        """Get session message history."""
        adapter = await self.get_adapter(user_id)
        return await adapter.get_session_history(agent_id, session_key, limit)

    async def get_workspace_path(self, user_id: str, agent_id: str) -> Path:
        """Get the workspace path for an agent."""
        adapter = await self.get_adapter(user_id)
        return await adapter.get_workspace_path(agent_id)

    async def list_workspace_files(
        self, user_id: str, agent_id: str, path: str | None = None
    ) -> list[WorkspaceFile]:
        """List files in an agent's workspace."""
        adapter = await self.get_adapter(user_id)
        return await adapter.list_workspace_files(agent_id, path)

    async def read_workspace_file(
        self, user_id: str, agent_id: str, path: str
    ) -> bytes:
        """Read a workspace file."""
        adapter = await self.get_adapter(user_id)
        return await adapter.read_workspace_file(agent_id, path)

    async def write_workspace_file(
        self, user_id: str, agent_id: str, path: str, content: bytes
    ) -> None:
        """Write a workspace file."""
        adapter = await self.get_adapter(user_id)
        await adapter.write_workspace_file(agent_id, path, content)

    async def delete_workspace_file(
        self, user_id: str, agent_id: str, path: str
    ) -> None:
        """Delete a workspace file."""
        adapter = await self.get_adapter(user_id)
        await adapter.delete_workspace_file(agent_id, path)

    async def prune_sandbox(self, user_id: str, agent_id: str) -> None:
        """Trigger sandbox cleanup for an agent."""
        adapter = await self.get_adapter(user_id)
        await adapter.prune_sandbox(agent_id)

    async def list_skills(self, user_id: str, agent_id: str) -> list[SkillInfo]:
        """List skills installed for an agent."""
        adapter = await self.get_adapter(user_id)
        return await adapter.list_skills(agent_id)

    async def install_skill(
        self, user_id: str, agent_id: str, skill_name: str
    ) -> None:
        """Install a skill to an agent."""
        adapter = await self.get_adapter(user_id)
        await adapter.install_skill(agent_id, skill_name)

    async def uninstall_skill(
        self, user_id: str, agent_id: str, skill_name: str
    ) -> None:
        """Uninstall a skill from an agent."""
        adapter = await self.get_adapter(user_id)
        await adapter.uninstall_skill(agent_id, skill_name)

    async def get_resource_usage(
        self, user_id: str, agent_id: str
    ) -> ResourceUsage:
        """Get resource usage for an agent."""
        adapter = await self.get_adapter(user_id)
        return await adapter.get_resource_usage(agent_id)

    async def get_instance_info(self, user_id: str) -> CoreInstanceInfo:
        """Get info about the backend serving this user."""
        adapter = await self.get_adapter(user_id)
        return await adapter.get_instance_info()

    async def health_check(self, user_id: str) -> bool:
        """Check if the backend for this user is healthy."""
        adapter = await self.get_adapter(user_id)
        return await adapter.health_check()

    # -------------------------------------------------------------------------
    # Lifecycle
    # -------------------------------------------------------------------------

    async def shutdown(self) -> None:
        """Clean shutdown: close shared adapter and all dedicated adapters."""
        await self._shared_adapter.close()
        for adapter in self._dedicated_adapters.values():
            await adapter.close()
        self._dedicated_adapters.clear()

    async def startup_idle_checker(self) -> asyncio.Task | None:
        """Start the background idle checker for dedicated containers.

        Returns the task so it can be cancelled on shutdown.
        """
        if self._cm is None:
            self._get_cm()
        task = asyncio.create_task(self._cm.run_idle_checker())
        return task


# -----------------------------------------------------------------------------
# Module-level singleton (created at app startup)
# -----------------------------------------------------------------------------

_router: AgentCoreRouter | None = None


def get_router() -> AgentCoreRouter:
    """Get the global AgentCoreRouter singleton."""
    global _router
    if _router is None:
        _router = AgentCoreRouter()
    return _router


def set_router(router: AgentCoreRouter) -> None:
    """Set the global router (for testing or replacement)."""
    global _router
    _router = router
