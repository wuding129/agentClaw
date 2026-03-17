# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentClaw is a multi-tenant AI skill development platform built on OpenClaw. It uses a **multi-agent architecture** where all users share a single OpenClaw Gateway instance, with each user getting an Agent that runs in an isolated Docker sandbox container.

**Architecture Flow:**
```
Browser (Frontend :3080)
    → Platform Gateway (FastAPI :8080)
        → Shared OpenClaw Instance (single container, :18080)
            → Agent Sandboxes (per-user Docker containers)
                → LLM Providers (via Gateway proxy with API key injection)
```

**Multi-Agent Architecture:**
- Single OpenClaw Gateway serves all users
- Each user = one Agent with sandbox isolation
- Session routing via `agent:<agentId>:<sessionKey>` format
- Agent sandboxes auto-pruned after 2 hours idle (configurable via `FRAMECLAW_AGENTS__DEFAULTS__SANDBOX__PRUNE__IDLEHOURS`)

## Development Commands

### Local Development (All Services)
```bash
# Start all services (PostgreSQL, Bridge, Gateway, Frontend)
python start_local.py

# Start specific services only
python start_local.py --only db,gateway,frontend

# Skip specific services
python start_local.py --skip bridge

# Stop all services
python start_local.py --stop
```

### Docker Deployment
```bash
# Prepare environment
python prepare.py

# Build and start all services
docker compose up -d --build

# Rebuild bridge image (after Dockerfile/entrypoint.sh changes)
docker build -t openclaw:latest ./bridge/
docker compose up -d --force-recreate openclaw-shared

# Rebuild bridge TypeScript only (fast, no image rebuild needed)
cd bridge && npx tsc
docker compose restart openclaw-shared

# Remove stale sandbox containers
docker ps -a --filter "name=openclaw-sbx" --format "{{.Names}}" | xargs -r docker rm -f

# View logs
docker compose logs -f

# Check service status
python check_status.py
```

### Platform Gateway (Python/FastAPI)
```bash
cd platform
# Install dependencies
pip install -e .[dev]

# Run with auto-reload
export PLATFORM_DATABASE_URL="postgresql+asyncpg://frameclaw:frameclaw@localhost:5432/frameclaw_platform"
python -m uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload

# Run tests
pytest
```

### Frontend (Vite/React/TypeScript)
```bash
cd frontend
npm install
npm run dev      # Development server on port 3080
npm run build    # Production build
npm run lint     # ESLint

# After build, copy to running container (Docker deployments):
docker cp dist/. openclaw-frontend:/usr/share/nginx/html/
```

### OpenClaw Bridge (TypeScript/Node.js)
```bash
cd bridge
npm install
tsx start.ts     # Start bridge + OpenClaw Gateway (dev mode)
npx tsc          # Build bridge TypeScript
```

## Service Ports

| Service | Port | Access |
|---------|------|--------|
| Frontend | 3080 | Public |
| Gateway | 8080 | Public |
| PostgreSQL | 15432 (Docker) / 5432 (local) | Internal |
| Bridge (container) | 18080 | Internal |
| OpenClaw Gateway (container) | 18789 | Loopback only |

## Key Components

### Platform Gateway (`platform/`)
Python FastAPI application — the control center for multi-tenant management.

**Route files (`platform/app/routes/`):**

| File | Endpoints | Purpose |
|------|-----------|---------|
| `auth.py` | `/api/auth/*` | Register, login, refresh, me, api-token, change-* |
| `agents.py` | `/api/agents/*` | CRUD + set-default (max 1 per regular user) |
| `proxy.py` | `/api/openclaw/*`, `/ws` | HTTP/WS reverse proxy to bridge with agentId routing |
| `admin.py` | `/api/admin/*` | User management, usage stats, container control |
| `skills.py` | `/api/skills/*`, `/api/curated-skills/*`, `/api/admin/...` | Full skill lifecycle |
| `llm.py` | `/api/llm/v1/*`, `/api/claude/*` | LLM proxy with quota enforcement |
| `notifications.py` | `/api/notifications/*` | In-app notification system |

**Key modules:**

| Module | File | Purpose |
|--------|------|---------|
| Auth | `app/auth/service.py` | JWT (HS256, 24h access / 30d refresh) + bcrypt |
| LLM Proxy | `app/llm_proxy/service.py` | API key injection, quota checking, usage tracking |
| HTTP/WS Proxy | `app/routes/proxy.py` | Forward to bridge with isAdmin signature |
| Config | `app/config.py` | All env vars, quota tiers, resource limits |

**Agent Lifecycle:**
- User registers → `agents.create` called on bridge → Agent created in shared OpenClaw
- User chats → Sandbox container created lazily per-agent
- Idle 2h → Sandbox auto-pruned (OpenClaw native, configurable)
- User deleted → `agents.delete` → Agent + sandbox + files removed

**Quota Tiers (tokens/day):**
- `free`: 20,000,000
- `basic`: 1,000,000
- `pro`: 10,000,000

### Database Models (`platform/app/db/models.py`)

| Model | Table | Key Fields |
|-------|-------|-----------|
| `User` | `users` | id, username, email, *_hash, role (user/admin), quota_tier (free/basic/pro), is_active |
| `UserAgent` | `user_agents` | user_id, openclaw_agent_id, name, is_default, soul_md, status (active/archived) |
| `Container` | `containers` | agent_id, docker_id, container_token (30d expiry), status, last_active_at |
| `UsageRecord` | `usage_records` | user_id, model, input_tokens, output_tokens, created_at (auto-cleanup 90d) |
| `AuditLog` | `audit_logs` | action, user_id, resource, detail |
| `CuratedSkill` | `curated_skills` | name, description, author, source_url, category, is_featured, install_count |
| `PlatformSkillVisibility` | `platform_skill_visibility` | skill_name, is_visible (admin toggle) |
| `SkillSubmission` | `skill_submissions` | user_id, skill_name, source_url, status (pending/approved/rejected), ai_review_result |
| `Notification` | `notifications` | user_id, type, title, content, link, is_read |
| `ReviewTask` | `review_tasks` | submission_id, status, assigned_agent, review_result |

### OpenClaw Bridge (`bridge/`)
Adapter layer connecting Platform Gateway to OpenClaw Agent Engine.

| File | Purpose |
|------|---------|
| `start.ts` | Entry point: write config → spawn OpenClaw Gateway → start HTTP server |
| `server.ts` | Express HTTP server + WebSocket relay with agentId extraction & event filtering |
| `gateway-client.ts` | WS client to local OpenClaw Gateway (Ed25519 handshake) |
| `config.ts` | Env var parsing, writes `openclaw.json` (sandbox config, LLM providers, web tools) |
| `utils.ts` | sessionKey conversion: `toOpenclawSessionKey(id, agentId)` → `agent:<agentId>:<id>` |
| `entrypoint.sh` | Container startup: sync platform skills → `~/.openclaw/skills/` |
| `Dockerfile` | Builds `openclaw:latest` image (aliyun mirrors for China builds) |

**Bridge Routes (`bridge/routes/` — 18 modules):**
`agents.ts`, `sessions.ts`, `skills.ts`, `filemanager.ts`, `channels.ts`, `cron.ts`, `nodes.ts`, `plugins.ts`, `marketplaces.ts`, `workspace.ts`, `commands.ts`, `reviews.ts`, `settings.ts`, `status.ts`, `files.ts`, `curated-skills.ts`, `knowledge.ts`, `notifications.ts`

**Auto-Review System:**
- Enabled via `BRIDGE_ENABLE_AUTO_REVIEW=true`
- Creates `skill-reviewer` agent on startup
- Polls `/api/reviews/pending` every 30s
- Validates frontmatter, name, description; scores 0–100 (critical: -30, major: -15, minor: -5)
- Submits results to `/api/reviews/result`

### Frontend (`frontend/`)
Vite + React + TypeScript with TailwindCSS. 20 pages total.

**User pages (all logged-in users):**
| Page | File | Description |
|------|------|-------------|
| Chat | `Chat.tsx` | Full chat interface: session list, multi-agent, file upload, WebSocket real-time |
| Skill Store | `SkillStore.tsx` | Browse/search/install skills, submit skills for review |
| File Manager | `FileManager.tsx` | Workspace file browser with per-agent isolation |
| Sessions | `Sessions.tsx` | Chat session history |
| Profile | `Profile.tsx` | Account settings, * change |
| API Access | `ApiAccess.tsx` | Long-lived API token management + CLI usage |

**Admin-only pages:**
| Page | File | Description |
|------|------|-------------|
| Dashboard | `Dashboard.tsx` | System/user agent overview with stats |
| Agents | `Agents.tsx` | Agent list |
| Agent Create | `AgentCreate.tsx` | Create new agents |
| Agent Detail | `AgentDetail.tsx` | Edit agent identity, SOUL.md, settings |
| Admin Users | `AdminUsers.tsx` | User management, quota/role modification, container control |
| Admin Skills | `AdminSkills.tsx` | Curated skills CRUD, platform skill visibility, submission review |
| AI Models | `AIModels.tsx` | LLM provider config (15+ providers, categories: official/cn/local/custom) |
| Channels | `Channels.tsx` | 17+ channel integrations (Telegram, Discord, Slack, etc.) |
| Cron Jobs | `CronJobs.tsx` | Scheduled task management |
| Knowledge Base | `KnowledgeBase.tsx` | Context/knowledge management |
| Nodes | `Nodes.tsx` | Node/resource management |
| System Settings | `SystemSettings.tsx` | Platform-wide settings |
| Audit Log | `AuditLog.tsx` | Action audit trail |

**Key components:**
| Component | Description |
|-----------|-------------|
| `Sidebar.tsx` | Navigation: dynamic menu based on role (admin/user), agent badge |
| `Layout.tsx` | Page wrapper, hosts ChatDrawer context |
| `TopBar.tsx` | Theme toggle, notifications dropdown, online indicator, logout |
| `ChatDrawer.tsx` | Slide-out chat panel (used from Dashboard/Agents) |
| `ThemeToggle.tsx` | Light/Dark/System mode switcher |

**Routing** (defined in `App.tsx`):
- Public: `/login`
- All logged-in: `/chat`, `/skills`, `/sessions`, `/files`, `/profile`, `/api`
- Admin only: `/dashboard`, `/agents/*`, `/models`, `/channels`, `/nodes`, `/cron`, `/knowledge`, `/admin/*`, `/settings`

## Theme System

**Dual theme (light/dark) via CSS variables:**
- Defined in `frontend/src/theme.css`
- `:root` = light defaults, `[data-theme="dark"]` = dark overrides
- Tailwind integration via `@theme` directive

**Color token naming conventions:**
- Backgrounds: `bg-bg-base`, `bg-bg-elevated`, `bg-bg-surface`, `bg-bg-floating`
- Text: `text-text-primary`, `text-text-secondary`, `text-text-tertiary`, `text-text-muted`
- Borders: `border-border-default`, `border-border-subtle`, `border-border-hover`
- Accents: `accent-blue`, `accent-green`, `accent-yellow`, `accent-red`, `accent-purple`
- Overlay: `bg-black/40` (NOT `bg-bg-overlay` — CSS variable circular reference issue in Tailwind v4)

**⚠️ Important:** Do NOT use `bg-bg-overlay` as a Tailwind class — the `@theme` variable creates a circular CSS reference. Use `bg-black/40` or `bg-black/50` for modal overlays instead.

**Theme persistence:** `localStorage` key `openclaw-theme`, three modes: `light`, `dark`, `system`.
Hook: `frontend/src/hooks/useTheme.ts`

**Old dark-specific class names are REMOVED** — all pages use the theme token system above. Do not use `bg-dark-card`, `text-dark-text`, `border-dark-border`, etc. in new code.

## Security Architecture

- **API Keys**: All LLM API keys exist ONLY in Gateway environment variables. Agent sandboxes access LLMs via proxy.
- **Agent Isolation**: Each user gets an Agent with Docker sandbox isolation.
- **Skill Visibility**: Non-main agents only see `workspace` skills + `skill-creator`. All other builtin/global skills are hidden.
- **Authentication Chain**: Frontend JWT → Gateway → X-Agent-Id header → Agent routing.
- **isAdmin Signature**: Gateway signs `hmac_sha256("{agentId}:{isAdmin}:{bridgeToken}")[:16]` — sent in `X-Is-Admin` header (HTTP) or `isAdminSig` query param (WebSocket). Bridge verifies before accepting admin commands.
- **Network**: Shared OpenClaw and agent sandboxes run in `openclaw-internal` network.
- **Sandbox Cleanup**: OpenClaw native `prune.idleHours` auto-cleans idle sandboxes (default: 2 hours).

## Sandbox Configuration

Sandbox settings in `bridge/config.ts` under `agents.defaults.sandbox`:

```json
{
  "mode": "all",
  "scope": "agent",
  "workspaceAccess": "rw",
  "docker": {
    "image": "openclaw-sandbox:agentclaw",
    "readOnlyRoot": false,
    "network": "bridge",
    "memory": "2g",
    "cpus": 2,
    "pidsLimit": 256
  },
  "prune": {
    "idleHours": 2
  }
}
```

**Important gotchas:**
- `sandbox.readOnlyRoot` is invalid — must use `sandbox.docker.readOnlyRoot`
- `sandbox.tools.fs.workspaceOnly` is invalid (not in schema)
- File isolation is enforced by scoping each agent to `workspace-<agentId>/`
- Custom sandbox image `openclaw-sandbox:agentclaw` built from `sandbox/Dockerfile` — preinstalled: Node.js 20, Python 3, pip, pnpm

## Data Storage

All persistent data lives at `~/.openclaw/` on the host, bind-mounted with the **same path** inside the openclaw-shared container:

```yaml
volumes:
  - ${HOME}/.openclaw:${HOME}/.openclaw
environment:
  OPENCLAW_HOME: ${HOME}/.openclaw
```

**Why same path?** When openclaw creates sandbox containers via Docker API, the bind mount source path must resolve on the Docker host (not inside the container). If paths differ, sandbox workspaces get empty mounts.

Per-user workspaces: `~/.openclaw/workspace-<agentId>/`

## Skill System

Three types of skills:

| Type | Source | Management |
|------|--------|-----------|
| **Platform Skills** | `bridge/entrypoint.sh` syncs from `/app/skills` | Admins toggle visibility per-skill |
| **Curated Skills** | Admin-uploaded ZIP files | Stored in `curated-skills` Docker volume |
| **User Submissions** | Users submit via SkillStore | Review workflow: pending → AI review → admin approve/reject |

**Skill visibility per agent:**
- `main` agent: all skills
- User agents: only `workspace` scope + `skill-creator`

**Skill review workflow:**
1. User submits skill (source URL or file)
2. Auto-review agent (optional) validates and scores
3. Admin approves/rejects via `AdminSkills.tsx`
4. On approval: skill installed to curated collection + notification sent to user

## AgentClaw Agent Persona

The SOUL.md template for regular users is defined in `platform/app/routes/auth.py` (`AGENTCLAW_SOUL_MD`).

To update existing agents after changing SOUL.md:
```bash
python3 -c "
import re, glob, os
soul = open('platform/app/routes/auth.py').read()
m = re.search(r\"AGENTCLAW_SOUL_MD = '''(.*?)'''\", soul, re.DOTALL)
if m:
    for ws in glob.glob(os.path.expanduser('~/.openclaw/workspace-*')):
        with open(os.path.join(ws, 'SOUL.md'), 'w') as f: f.write(m.group(1))
        print(f'Updated: {ws}')
"
```

## Environment Configuration

Create `.env` in project root (see `.env.example`):

```bash
# Required: At least one LLM provider API key
ANTHROPIC_API_KEY=sk-ant-xxx
OPENAI_API_KEY=sk-xxx
DASHSCOPE_API_KEY=sk-xxx        # 通义千问
DEEPSEEK_API_KEY=sk-xxx
MOONSHOT_API_KEY=sk-xxx         # Kimi (also used for web_search)
OPENROUTER_API_KEY=sk-or-v1-xxx
ZHIPU_API_KEY=xxx

# Default model for new agents
DEFAULT_MODEL=dashscope/qwen3-coder-plus

# Security: JWT signing secret (generate: python -c "import secrets; print(secrets.token_urlsafe(32))")
JWT_SECRET=your-secure-random-string

# Bridge security token (must match between gateway and bridge)
BRIDGE_TOKEN=your-bridge-token

# Self-hosted vLLM (optional)
HOSTED_VLLM_API_KEY=dummy
HOSTED_VLLM_API_BASE=http://localhost:8000/v1

# Web search (optional, auto-detected in order: Brave → Gemini → Kimi → Perplexity → Grok)
BRAVE_API_KEY=xxx
KIMI_API_KEY=xxx

# Auto-review feature (optional)
BRIDGE_ENABLE_AUTO_REVIEW=false
```

## WebSocket Protocol

Frontend → Gateway → Bridge → OpenClaw Gateway (layered proxy):

```json
// Send message
{ "type": "req", "id": 1, "method": "chat.send", "params": { "sessionKey": "...", "message": "..." } }

// Receive event
{ "type": "event", "event": "chat.message.received", "payload": { "content": "..." } }

// Heartbeat
{ "type": "ping" } / { "type": "pong" }
```

**Chat real-time:** Frontend connects via WebSocket, listens for `chat` events with `state: "final"`. Falls back to HTTP polling if WebSocket unavailable. Debounce 500ms handles multi-turn (tool call → response → tool call) sequences.

## Frontend Build Notes

The frontend is a static build (Vite → Nginx). After modifying frontend source files:

```bash
cd frontend
npm run build                           # Build production bundle
docker cp dist/. openclaw-frontend:/usr/share/nginx/html/  # Copy to container
```

For Docker deployments, the frontend is built during image creation. Manual copy is faster for iterative changes without full rebuild.

## Docker Orchestration

**Networks:**
- `openclaw-internal`: postgres, gateway, openclaw-shared (isolated)
- `openclaw-external`: gateway, frontend (public-facing)

**Volumes:**
- `pgdata` — PostgreSQL data
- `userdata` — User container metadata
- `curated-skills` — Admin-uploaded skill packages
- `platform-skills` — Built-in skills from bridge (populated on startup)
- `${HOME}/.openclaw` — Host bind mount (same path both sides — critical!)
- `/var/run/docker.sock` — Docker socket for sandbox management (gateway + bridge)
