"""Platform Gateway — main FastAPI application."""

import asyncio
import logging
from contextlib import asynccontextmanager
from urllib.parse import urlparse, urlunparse

import asyncpg
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db.engine import engine
from app.db.models import Base
from app.routes import agents, auth, llm, proxy, admin, skills, notifications

logger = logging.getLogger(__name__)


async def _ensure_database() -> None:
    """Connect to the default 'postgres' DB and create the target database if missing."""
    parsed = urlparse(settings.database_url)
    db_name = parsed.path.lstrip("/")
    # Build a URL pointing to the default 'postgres' database
    admin_url = urlunparse(parsed._replace(path="/postgres"))
    # asyncpg uses postgresql:// not postgresql+asyncpg://
    admin_url = admin_url.replace("postgresql+asyncpg://", "postgresql://", 1)

    max_retries = 30
    for attempt in range(1, max_retries + 1):
        try:
            conn = await asyncpg.connect(admin_url)
            break
        except (OSError, asyncpg.PostgresError) as exc:
            if attempt == max_retries:
                raise RuntimeError(
                    f"Cannot connect to PostgreSQL after {max_retries} attempts"
                ) from exc
            logger.warning("Waiting for PostgreSQL (attempt %d/%d): %s", attempt, max_retries, exc)
            await asyncio.sleep(2)

    try:
        exists = await conn.fetchval(
            "SELECT 1 FROM pg_database WHERE datname = $1", db_name
        )
        if not exists:
            # CREATE DATABASE cannot run inside a transaction
            await conn.execute(f'CREATE DATABASE "{db_name}"')
            logger.info("Created database '%s'", db_name)
        else:
            logger.info("Database '%s' already exists", db_name)
    finally:
        await conn.close()


async def _run_database_migrations() -> None:
    """Auto-run database migrations on startup.

    Checks for missing columns/indexes and adds them automatically.
    This ensures schema is always up to date without manual intervention.
    """
    from sqlalchemy import text

    async with engine.begin() as conn:
        # Check if token_expires_at column exists using information_schema
        result = await conn.execute(text("""
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'containers' AND column_name = 'token_expires_at'
        """))
        if result.scalar():
            logger.debug("Column token_expires_at already exists")
        else:
            logger.info("Adding token_expires_at column to containers table...")
            await conn.execute(text("""
                ALTER TABLE containers
                ADD COLUMN token_expires_at TIMESTAMP
                DEFAULT NOW() + INTERVAL '30 days'
            """))
            logger.info("Added token_expires_at column successfully")

        # Check if index exists on usage_records.created_at
        result = await conn.execute(text("""
            SELECT 1 FROM pg_indexes
            WHERE indexname = 'ix_usage_records_created_at'
        """))
        if result.scalar():
            logger.debug("Index ix_usage_records_created_at already exists")
        else:
            logger.info("Adding index on usage_records.created_at...")
            await conn.execute(text("""
                CREATE INDEX ix_usage_records_created_at ON usage_records(created_at)
            """))
            logger.info("Added index successfully")

        # Migration: Rename containers.user_id to containers.agent_id
        result = await conn.execute(text("""
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'containers' AND column_name = 'agent_id'
        """))
        if not result.scalar():
            logger.info("Renaming containers.user_id to containers.agent_id...")
            await conn.execute(text("""
                ALTER TABLE containers RENAME COLUMN user_id TO agent_id
            """))
            logger.info("Renamed column successfully")

        # Migration: Create user_agents table
        result = await conn.execute(text("""
            SELECT 1 FROM information_schema.tables
            WHERE table_name = 'user_agents'
        """))
        if not result.scalar():
            logger.info("Creating user_agents table...")
            await conn.execute(text("""
                CREATE TABLE user_agents (
                    id VARCHAR(36) PRIMARY KEY,
                    user_id VARCHAR(36) NOT NULL,
                    openclaw_agent_id VARCHAR(128) NOT NULL UNIQUE,
                    name VARCHAR(128) NOT NULL,
                    description TEXT DEFAULT '',
                    is_default BOOLEAN DEFAULT FALSE,
                    soul_md TEXT DEFAULT '',
                    status VARCHAR(16) DEFAULT 'active',
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            """))
            await conn.execute(text("""
                CREATE INDEX ix_user_agents_user_id ON user_agents(user_id)
            """))
            logger.info("Created user_agents table successfully")

        # Future migrations can be added here following the same pattern


async def _cleanup_temp_skill_submissions() -> None:
    """Clean up expired temporary skill submission files (older than 7 days)."""
    from pathlib import Path
    import shutil
    from datetime import datetime, timedelta

    temp_dir = Path("/tmp/skill-submissions")
    if not temp_dir.exists():
        return

    cutoff = datetime.now() - timedelta(days=7)
    cleaned = 0
    failed = 0

    for entry in temp_dir.iterdir():
        if not entry.is_dir():
            continue
        try:
            # Check modification time
            stat = entry.stat()
            mtime = datetime.fromtimestamp(stat.st_mtime)
            if mtime < cutoff:
                shutil.rmtree(entry)
                cleaned += 1
                logger.debug("Cleaned up temp skill dir: %s", entry)
        except Exception as e:
            failed += 1
            logger.warning("Failed to clean up temp skill dir %s: %s", entry, e)

    if cleaned > 0 or failed > 0:
        logger.info("Temp skill cleanup: %d cleaned, %d failed", cleaned, failed)


async def _sync_platform_skills() -> None:
    """Sync platform skills from filesystem to database on startup."""
    from pathlib import Path
    import re
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession
    from app.db.engine import async_session
    from app.db.models import PlatformSkillVisibility

    platform_dir = Path(settings.platform_skills_dir)
    if not platform_dir.exists():
        logger.info("Platform skills directory does not exist: %s", platform_dir)
        return

    async with async_session() as db:
        added = 0
        for skill_dir in platform_dir.iterdir():
            if not skill_dir.is_dir():
                continue

            skill_name = skill_dir.name
            skill_md = skill_dir / "SKILL.md"
            if not skill_md.exists():
                continue

            # Check if already exists
            existing = (await db.execute(
                select(PlatformSkillVisibility).where(PlatformSkillVisibility.skill_name == skill_name)
            )).scalar_one_or_none()

            if existing is None:
                # Parse description from SKILL.md
                try:
                    content = skill_md.read_text(encoding='utf-8')
                    # Extract description from frontmatter
                    desc_match = re.search(r'^description:\s*(.+)$', content, re.MULTILINE)
                    description = desc_match.group(1).strip() if desc_match else ""

                    # Extract requirements from metadata
                    reqs_match = re.search(r'requires.*?bins:\s*\[([^\]]+)\]', content)
                    requirements = reqs_match.group(1) if reqs_match else ""
                except Exception:
                    description = ""
                    requirements = ""

                skill = PlatformSkillVisibility(
                    skill_name=skill_name,
                    is_visible=True,  # Default to visible
                    description=description,
                    category="general",
                    requirements=requirements,
                )
                db.add(skill)
                added += 1
                logger.info("Added platform skill: %s", skill_name)

        await db.commit()
        if added > 0:
            logger.info("Platform skills synced: %d new skills added", added)
        else:
            logger.info("Platform skills sync: no new skills found")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure the target database exists before creating tables
    await _ensure_database()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("Database tables verified")

    # Run automatic database migrations
    await _run_database_migrations()

    # Sync platform skills from filesystem to database
    await _sync_platform_skills()

    # Clean up expired temp skill submissions on startup
    await _cleanup_temp_skill_submissions()

    # Clean up old usage records on startup
    await _cleanup_old_usage_records()

    # Start background task for periodic cleanup (every 6 hours)
    cleanup_task = asyncio.create_task(_periodic_cleanup())

    yield

    # Cancel cleanup task on shutdown
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass
    await engine.dispose()


async def _refresh_container_tokens() -> None:
    """Refresh container tokens that are about to expire (within 7 days)."""
    from datetime import datetime, timedelta
    from sqlalchemy import select
    from app.db.engine import async_session
    from app.db.models import Container

    async with async_session() as db:
        # Find tokens expiring within 7 days
        threshold = datetime.utcnow() + timedelta(days=7)
        result = await db.execute(
            select(Container).where(Container.token_expires_at < threshold)
        )
        containers = result.scalars().all()

        refreshed = 0
        for container in containers:
            try:
                container.refresh_token()
                refreshed += 1
                logger.debug("Refreshed token for container %s", container.id)
            except Exception as e:
                logger.error("Failed to refresh token for container %s: %s", container.id, e)

        if refreshed > 0:
            await db.commit()
            logger.info("Refreshed %d container tokens", refreshed)


async def _cleanup_old_usage_records() -> None:
    """Delete usage records older than 90 days to prevent unlimited growth."""
    from datetime import datetime, timedelta
    from sqlalchemy import delete
    from app.db.engine import async_session
    from app.db.models import UsageRecord

    async with async_session() as db:
        cutoff = datetime.utcnow() - timedelta(days=90)
        result = await db.execute(
            delete(UsageRecord).where(UsageRecord.created_at < cutoff)
        )
        deleted = result.rowcount
        if deleted > 0:
            await db.commit()
            logger.info("Cleaned up %d old usage records (older than 90 days)", deleted)


async def _periodic_cleanup() -> None:
    """Run cleanup tasks periodically."""
    while True:
        try:
            await asyncio.sleep(6 * 60 * 60)  # 6 hours
            await _cleanup_temp_skill_submissions()
            await _refresh_container_tokens()
            await _cleanup_old_usage_records()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error("Error in periodic cleanup: %s", e)


app = FastAPI(
    title="OpenClaw Platform",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount route groups
app.include_router(auth.router)
app.include_router(agents.router)
app.include_router(llm.router)
app.include_router(proxy.router)
app.include_router(admin.router)
app.include_router(skills.user_router)
app.include_router(skills.admin_router)
app.include_router(notifications.user_router)
app.include_router(notifications.internal_router)


@app.get("/api/ping")
async def ping():
    return {"message": "pong", "service": "openclaw-platform"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=settings.host, port=settings.port)
