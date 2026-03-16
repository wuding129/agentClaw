"""SQLAlchemy ORM models for the platform."""

from datetime import datetime, timedelta
import uuid

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from typing import Optional


class Base(DeclarativeBase):
    pass


class User(Base):
    """Platform user account."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(256), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(256), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="user")  # user | admin
    quota_tier: Mapped[str] = mapped_column(String(16), nullable=False, default="free")  # free | basic | pro
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class UserAgent(Base):
    """User's agent in the platform (supports multiple agents per user)."""

    __tablename__ = "user_agents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    openclaw_agent_id: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    # Display name for the agent (user can customize)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # Whether this is the user's default agent
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Agent persona (SOUL.md content)
    soul_md: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # Agent status: active | archived
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class Container(Base):
    """Per-agent Docker container metadata (sandbox container token)."""

    __tablename__ = "containers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    # Changed from user_id to agent_id - each agent has its own container token
    agent_id: Mapped[str] = mapped_column(String(36), nullable=False, unique=True, index=True)
    docker_id: Mapped[str] = mapped_column(String(128), nullable=True)  # Docker container ID
    container_token: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    # Token expiration for security (default 30 days)
    token_expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=lambda: datetime.utcnow() + timedelta(days=30))
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="creating")
    # Status: creating | running | paused | archived
    internal_host: Mapped[str] = mapped_column(String(64), nullable=True)
    internal_port: Mapped[int] = mapped_column(Integer, nullable=True, default=18080)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    last_active_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    def is_token_expired(self) -> bool:
        """Check if container token has expired."""
        return datetime.utcnow() > self.token_expires_at

    def refresh_token(self) -> None:
        """Generate new token and extend expiration."""
        import uuid
        self.container_token = str(uuid.uuid4())
        self.token_expires_at = datetime.utcnow() + timedelta(days=30)


class UsageRecord(Base):
    """LLM token usage per request."""

    __tablename__ = "usage_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    model: Mapped[str] = mapped_column(String(128), nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)

    # Retention policy: records older than 90 days are automatically deleted
    # This is enforced by _cleanup_old_usage_records() in main.py


class AuditLog(Base):
    """Audit trail for key operations."""

    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False)  # login | llm_call | container_create | ...
    resource: Mapped[str] = mapped_column(String(128), nullable=True)
    detail: Mapped[str] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class CuratedSkill(Base):
    """Platform-curated skill recommended to all users."""

    __tablename__ = "curated_skills"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    author: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    source_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    category: Mapped[str] = mapped_column(String(64), nullable=False, default="general")
    is_featured: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    install_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_by: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class PlatformSkillVisibility(Base):
    """Platform skill visibility configuration - admin can control which platform skills are visible to users."""

    __tablename__ = "platform_skill_visibility"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    skill_name: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    is_visible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    category: Mapped[str] = mapped_column(String(64), nullable=False, default="general")
    requirements: Mapped[str] = mapped_column(Text, nullable=False, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class SkillSubmission(Base):
    """User-submitted skill for admin review."""

    __tablename__ = "skill_submissions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    skill_name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    source_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    file_path: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)  # temp uploaded zip path
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")  # pending | approved | rejected
    ai_review_result: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # AI review JSON result
    admin_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    reviewed_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    version: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)  # e.g., v1.0 after approved
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class Notification(Base):
    """User notifications."""

    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(32), nullable=False)  # skill_approved, skill_rejected, system, etc.
    title: Mapped[str] = mapped_column(String(128), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    link: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)  # optional link to related page
    is_read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class ReviewTask(Base):
    """Skill review tasks for the review agent."""

    __tablename__ = "review_tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    submission_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)  # links to SkillSubmission
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")  # pending | assigned | completed | failed
    assigned_agent: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)  # agent id that claimed this task
    assigned_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)  # when task was claimed
    skill_content: Mapped[str] = mapped_column(Text, nullable=False)  # SKILL.md content
    review_result: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON review result
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
