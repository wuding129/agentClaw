"""Agent personas and templates for AgentClaw platform."""

import os
from pathlib import Path

# Config directory mounted at /app/config in container
_CONFIG_DIR = Path("/app/config")


def load_persona(filename: str) -> str:
    """Load a persona template from the config directory.

    Args:
        filename: Name of the persona file (e.g., "SOUL.md")

    Returns:
        The content of the persona file as a string.

    Raises:
        FileNotFoundError: If the persona file doesn't exist
    """
    filepath = _CONFIG_DIR / filename
    if not filepath.exists():
        raise FileNotFoundError(f"Persona file not found: {filepath}")
    return filepath.read_text(encoding="utf-8")


def load_soul_md() -> str:
    """Load the default AgentClaw SOUL.md template for regular users."""
    return load_persona("SOUL.md")


def load_admin_persona() -> str:
    """Load the admin persona (uses default OpenClaw behavior)."""
    # Admin users don't get a custom SOUL.md, they use OpenClaw default
    return ""


# Backward compatibility
AGENTCLAW_SOUL_MD = load_soul_md()
