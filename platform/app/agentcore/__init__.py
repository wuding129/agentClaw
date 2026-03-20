"""AgentCore — pluggable agent engine abstraction layer.

Phase 0 provides:
- IAgentCore interface: unified contract for all agent backends
- SharedOpenClawAdapter: wraps existing bridge as IAgentCore
- TierConfigManager: loads tier rules from tiers.yaml
- AgentCoreRouter: routes operations to the right adapter

All existing routes continue to work unchanged. Phase 0 adds the abstraction
without changing behaviour.
"""

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
from app.agentcore.adapters import (
    SharedOpenClawAdapter,
    AgentCoreError,
    AgentCreationError,
    AgentDeletionError,
    BackendUnavailableError,
    SkillInstallError,
)
from app.agentcore.config.tiers import TierConfig, TierConfigManager
from app.agentcore.router import AgentCoreRouter, get_router, set_router

__all__ = [
    # Interfaces
    "IAgentCore",
    "AgentConfig",
    "AgentStatus",
    "BackendType",
    "CoreEvent",
    "CoreInstanceInfo",
    "EventType",
    "ResourceUsage",
    "Session",
    "SkillInfo",
    "WorkspaceFile",
    # Adapters
    "SharedOpenClawAdapter",
    "AgentCoreError",
    "AgentCreationError",
    "AgentDeletionError",
    "BackendUnavailableError",
    "SkillInstallError",
    # Config
    "TierConfig",
    "TierConfigManager",
    # Router
    "AgentCoreRouter",
    "get_router",
    "set_router",
]
