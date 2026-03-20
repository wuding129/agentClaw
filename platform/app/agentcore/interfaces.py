"""IAgentCore — unified interface for all agent engine backends."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Coroutine


class BackendType(Enum):
    """Supported agent engine backend types."""

    SHARED_OPENCLAW = "shared_openclaw"
    DEDICATED_OPENCLAW = "dedicated_openclaw"
    CLAUDE_CODE = "claude_code"


class EventType(Enum):
    """Normalized event types across all backends."""

    MESSAGE = "message"
    TOOL_CALL = "tool_call"
    TOOL_START = "tool_start"
    TOOL_RESULT = "tool_result"
    TOOL_END = "tool_end"
    SESSION_CREATED = "session_created"
    SESSION_DELETED = "session_deleted"
    AGENT_STOPPED = "agent_stopped"
    ERROR = "error"
    STREAMING = "streaming"
    DONE = "done"


@dataclass
class AgentConfig:
    """Configuration for creating an agent."""

    name: str
    model: str
    personality: str | None = None  # SOUL.md content
    settings: dict[str, Any] | None = None


@dataclass
class AgentStatus:
    """Status of an agent."""

    agent_id: str
    status: str  # creating / running / stopped / archived / error
    sandbox_status: str | None = None  # running / stopped (sandbox-based only)


@dataclass
class Session:
    """A conversation session."""

    session_key: str
    created_at: datetime
    last_active_at: datetime
    message_count: int = 0


@dataclass
class WorkspaceFile:
    """A file in the agent workspace."""

    name: str
    path: str
    type: str  # "file" or "directory"
    size: int = 0
    modified_at: datetime | None = None


@dataclass
class SkillInfo:
    """Information about an installed skill."""

    name: str
    description: str
    enabled: bool = True
    author: str = ""


@dataclass
class ResourceUsage:
    """Resource usage for an agent or instance."""

    cpu_percent: float = 0.0
    memory_mb: int = 0
    sandbox_count: int = 0
    active_sessions: int = 0


@dataclass
class CoreInstanceInfo:
    """Metadata about a backend instance."""

    instance_id: str
    backend_type: BackendType
    version: str = ""
    region: str | None = None
    max_agents: int | None = None
    max_sandboxes: int | None = None


@dataclass
class CoreEvent:
    """
    Normalized event from any agent core backend.
    All adapters must convert their native event format to this.
    """

    event_type: EventType
    session_key: str
    content: Any = None
    metadata: dict[str, Any] = field(default_factory=dict)
    trace_id: str | None = None


class IAgentCore(ABC):
    """
    Unified interface for all agent engine backends.

    Implement this interface for each backend (OpenClaw, Claude Code, etc.)
    to enable pluggable agent cores with zero changes to Platform Gateway.
    """

    # -------------------------------------------------------------------------
    # Identity
    # -------------------------------------------------------------------------

    @property
    @abstractmethod
    def backend_type(self) -> BackendType:
        """Backend type identifier."""
        ...

    @property
    @abstractmethod
    def instance_id(self) -> str:
        """Globally unique instance identifier, e.g. 'shared-openclaw-1'."""
        ...

    # -------------------------------------------------------------------------
    # Agent lifecycle
    # -------------------------------------------------------------------------

    @abstractmethod
    async def create_agent(self, config: AgentConfig) -> str:
        """
        Create an agent on the backend.

        Returns:
            The backend-specific agent identifier (e.g. openclaw_agent_id).

        Raises:
            AgentCreationError: If creation fails.
            BackendUnavailableError: If the backend is unreachable.
        """
        ...

    @abstractmethod
    async def delete_agent(self, agent_id: str) -> None:
        """
        Delete an agent and all associated resources (sandbox, sessions, files).
        """
        ...

    @abstractmethod
    async def get_agent_status(self, agent_id: str) -> AgentStatus:
        """Query the current status of an agent."""
        ...

    # -------------------------------------------------------------------------
    # Session management
    # -------------------------------------------------------------------------

    @abstractmethod
    async def send_message(
        self,
        agent_id: str,
        session_key: str,
        message: str,
        on_event: Callable[[CoreEvent], None] | None = None,
    ) -> None:
        """
        Send a message to an agent session.

        Args:
            agent_id: The backend agent identifier.
            session_key: Session key (format is backend-specific).
            message: The user's message.
            on_event: If provided, events are streamed via this callback.
                      If None, the implementation may block until complete.
        """
        ...

    @abstractmethod
    async def list_sessions(self, agent_id: str) -> list[Session]:
        """List all sessions for an agent."""
        ...

    @abstractmethod
    async def delete_session(self, agent_id: str, session_key: str) -> None:
        """Delete a specific session."""
        ...

    @abstractmethod
    async def get_session_history(
        self, agent_id: str, session_key: str, limit: int | None = None
    ) -> list[dict[str, Any]]:
        """
        Retrieve the message history for a session.

        Returns:
            List of message dicts with at least 'role' and 'content' keys.
        """
        ...

    # -------------------------------------------------------------------------
    # Workspace / Files
    # -------------------------------------------------------------------------

    @abstractmethod
    async def get_workspace_path(self, agent_id: str) -> Path:
        """Get the absolute workspace path for an agent."""
        ...

    @abstractmethod
    async def list_workspace_files(
        self, agent_id: str, path: str | None = None
    ) -> list[WorkspaceFile]:
        """List files in the agent workspace."""
        ...

    @abstractmethod
    async def read_workspace_file(self, agent_id: str, path: str) -> bytes:
        """Read a workspace file as binary content."""
        ...

    @abstractmethod
    async def write_workspace_file(
        self, agent_id: str, path: str, content: bytes
    ) -> None:
        """Write binary content to a workspace file."""
        ...

    @abstractmethod
    async def delete_workspace_file(self, agent_id: str, path: str) -> None:
        """Delete a workspace file or directory."""
        ...

    @abstractmethod
    async def prune_sandbox(self, agent_id: str) -> None:
        """
        Actively reclaim the sandbox for an agent.

        For sandbox-based backends (shared OpenClaw with docker scope=agent),
        this forces sandbox cleanup.

        For dedicated backends, this may be a no-op.
        """
        ...

    # -------------------------------------------------------------------------
    # Skills
    # -------------------------------------------------------------------------

    @abstractmethod
    async def list_skills(self, agent_id: str) -> list[SkillInfo]:
        """List all skills installed for an agent."""
        ...

    @abstractmethod
    async def install_skill(self, agent_id: str, skill_name: str) -> None:
        """Install a skill to an agent."""
        ...

    @abstractmethod
    async def uninstall_skill(self, agent_id: str, skill_name: str) -> None:
        """Uninstall a skill from an agent."""
        ...

    # -------------------------------------------------------------------------
    # Resource & Health
    # -------------------------------------------------------------------------

    @abstractmethod
    async def get_resource_usage(self, agent_id: str) -> ResourceUsage:
        """Get resource usage for an agent."""
        ...

    @abstractmethod
    async def get_instance_info(self) -> CoreInstanceInfo:
        """Get metadata about this backend instance."""
        ...

    @abstractmethod
    async def health_check(self) -> bool:
        """Check if the backend is reachable and healthy."""
        ...
