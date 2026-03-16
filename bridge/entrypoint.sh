#!/bin/bash
set -e

# Use OPENCLAW_HOME if set, fallback to ~/.openclaw
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"

# Create necessary directories
mkdir -p "$OPENCLAW_HOME/workspace"
mkdir -p "$OPENCLAW_HOME/uploads"
mkdir -p "$OPENCLAW_HOME/sessions"
mkdir -p "$OPENCLAW_HOME/skills"

# Install platform built-in skills (always overwrite to keep up-to-date)
PLATFORM_SKILLS_DIR="/app/skills"
if [ -d "$PLATFORM_SKILLS_DIR" ]; then
  cp -r "$PLATFORM_SKILLS_DIR/"* "$OPENCLAW_HOME/skills/" 2>/dev/null || true
  echo "[entrypoint] Platform skills synced"
fi

# Copy skills from project source directory (lowest priority, can be overridden by builtin)
PROJECT_SKILLS_DIR="/app/project-skills"
if [ -d "$PROJECT_SKILLS_DIR" ]; then
  for skill_dir in "$PROJECT_SKILLS_DIR"/*/; do
    if [ -d "$skill_dir" ]; then
      skill_name=$(basename "$skill_dir")
      # Skip skill-creator if exists (will be handled separately)
      if [ "$skill_name" != "skill-creator" ]; then
        cp -r "$skill_dir" "$OPENCLAW_HOME/skills/"
        echo "[entrypoint] Project skill synced: $skill_name"
      fi
    fi
  done
fi

# Copy skill-creator: prefer project version, fallback to builtin
BUILTIN_SKILLS="$(npm root -g)/openclaw/skills"
PROJECT_SKILL_CREATOR="$PROJECT_SKILLS_DIR/skill-creator"

if [ -d "$PROJECT_SKILL_CREATOR" ]; then
  # Use project custom skill-creator
  cp -r "$PROJECT_SKILL_CREATOR" "$OPENCLAW_HOME/skills/"
  echo "[entrypoint] skill-creator synced from project"
elif [ -d "$BUILTIN_SKILLS/skill-creator" ]; then
  # Fallback to openclaw builtin
  cp -r "$BUILTIN_SKILLS/skill-creator" "$OPENCLAW_HOME/skills/"
  echo "[entrypoint] skill-creator synced from builtin"
fi

# Sync skills to platform-skills volume for gateway to scan
# This is read-only; user-submitted curated skills go to a separate location
PLATFORM_SKILLS_DIR="/app/platform-skills"
if [ -d "$PLATFORM_SKILLS_DIR" ]; then
  # Clear and repopulate platform-skills (keep in sync with OPENCLAW_HOME/skills)
  rm -rf "${PLATFORM_SKILLS_DIR:?}/"*
  cp -r "$OPENCLAW_HOME/skills/"* "$PLATFORM_SKILLS_DIR/" 2>/dev/null || true
  echo "[entrypoint] Platform skills synced to volume: $(ls -1 "$PLATFORM_SKILLS_DIR" 2>/dev/null | wc -l) skills"
fi

# If FRAMECLAW_PROXY__URL is set, we're running in platform mode
if [ -n "$FRAMECLAW_PROXY__URL" ]; then
  echo "[entrypoint] Platform mode detected"
  echo "[entrypoint] Proxy URL: $FRAMECLAW_PROXY__URL"
  echo "[entrypoint] Model: $FRAMECLAW_AGENTS__DEFAULTS__MODEL"
fi

exec "$@"
