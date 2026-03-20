"""Agent core adapters — pluggable implementations of IAgentCore."""

from app.agentcore.adapters.shared import (
    AgentCoreError,
    AgentCreationError,
    AgentDeletionError,
    BackendUnavailableError,
    SharedOpenClawAdapter,
    SkillInstallError,
)

# Import lazily to avoid circular dependency
_dedicated = None


def _get_dedicated():
    global _dedicated
    if _dedicated is None:
        from app.agentcore.adapters.dedicated import DedicatedOpenClawAdapter
        _dedicated = DedicatedOpenClawAdapter
    return _dedicated


__all__ = [
    "SharedOpenClawAdapter",
    "AgentCoreError",
    "AgentCreationError",
    "AgentDeletionError",
    "BackendUnavailableError",
    "SkillInstallError",
]
