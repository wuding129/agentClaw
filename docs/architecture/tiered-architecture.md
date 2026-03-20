# Tiered Agent Core Architecture

> 文档版本: v0.1.0  
> 分支: `feature/tiered-architecture`  
> 状态: 设计中

## 一、设计目标

AgentClaw 当前基于单 OpenClaw 实例的多租户架构，通过 Docker sandbox per-agent 实现租户隔离。本文档描述其演进目标：

1. **Tiered Isolation**：Free/Basic 用户共享 OpenClaw，Pro/Enterprise 用户独享 OpenClaw 容器
2. **Zero-Intrusion Abstraction**：用户操作界面完全无感知底层差异
3. **Pluggable Agent Core**：未来可替换 agent engine，不改 platform 层
4. **Configuration-Driven**：隔离策略通过配置驱动，新增 tier 只需改配置

---

## 二、当前架构分析

### 2.1 现状

```
User Browser
    │
    ▼
Platform Gateway (FastAPI :8080)
    │ JWT Auth / LLM Proxy / Quota / Skill
    │ X-Agent-Id routing
    ▼
Bridge (Node.js :18080) ──► OpenClaw Gateway (:18789)
    │ WS relay / REST API / Config injection
    ▼
Sandbox per Agent (Docker, scope=agent)
```

关键约束：
- **单 OpenClaw 实例**：所有用户的 agent 共享同一个 OpenClaw Gateway 进程
- **sandbox 隔离**：通过 `scope=agent` 配置，per-agent Docker 容器隔离
- **Bridge 强绑定**：16 个 bridge 路由模块（agents/sessions/skills/files/cron/channels 等）全部是 OpenClaw 原生 API 封装
- **租户映射**：`X-Agent-Id` header 做单层路由，session key 格式 `agent:{agentId}:{sessionKey}`

### 2.2 当前痛点

| 方面 | 问题 |
|------|------|
| **容量** | 单机 Docker 上限 = 系统容量上限，无法 scale out |
| **隔离** | agent 间共享 OpenClaw 进程，一个 agent 跑满 CPU 影响全局 |
| **故障域** | OpenClaw 单点故障影响所有用户 |
| **OpenClaw 耦合** | Bridge 70%+ 代码是 OpenClaw 原生 API，换 core = 重写 |
| **Tier 缺失** | 无法给付费用户提供更高隔离级别 |

### 2.3 参考实现：MultiUserClaw

[MultiUserClaw](https://github.com/johnson7788/MultiUserClaw) 提供了另一种多租户思路：

- 每个用户一个独立 Docker 容器
- 容器内运行完整 OpenClaw + Bridge
- Platform Gateway 按需创建/暂停/销毁容器
- 容器空闲 30 分钟暂停，30 天归档

MultiUserClaw 证明了 **per-tenant 完整 OpenClaw 可行**，其 `platform/container/manager.py` 是本研究复用的容器管理逻辑来源。

---

## 三、目标架构

### 3.1 分层总览

```
┌─────────────────────────────────────────────────────────────┐
│                     User Browser                            │
│               Frontend (React + Vite)                        │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP / WebSocket
┌──────────────────────────▼──────────────────────────────────┐
│                    Platform Gateway                           │
│                   FastAPI + PostgreSQL                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  JWT Auth   │  │  LLM Proxy │  │  AgentCoreRouter (NEW)│  │
│  └─────────────┘  └─────────────┘  └──────────────────────┘  │
│                     ┌──────────────┐                        │
│                     │ TierRegistry  │                        │
│                     │ (配置驱动)    │                        │
│                     └──────┬───────┘                        │
└────────────────────────────┼───────────────────────────────┘
                             │ agent_id → IAgentCore
          ┌──────────────────┼──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ SharedOpenClaw  │  │DedicatedOpenClaw│  │ ClaudeCodeAdapter│
│   Adapter       │  │   Adapter        │  │   (未来)         │
│                 │  │                  │  │                 │
│ shared-instance │  │ per-tenant 容器   │  │ per-tenant 容器  │
│ bridge (:18080) │  │ bridge (:18080)  │  │ Claude Code      │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

### 3.2 Tier 划分

| Tier | Agent Core | 隔离模式 | 适用场景 |
|------|-----------|---------|---------|
| `free` | 共享 OpenClaw | Docker sandbox per agent | 个人试用 |
| `basic` | 共享 OpenClaw | Docker sandbox per agent | 小团队基础使用 |
| `pro` | 独立 OpenClaw 容器 | 完整 OpenClaw + Bridge | 独立资源，高隔离 |
| `enterprise` | 独立 OpenClaw 容器 | 高配实例 + 更大资源 | 团队/企业，高需求 |

**关键原则**：Free/Basic 和 Pro/Enterprise 的**用户体验完全一致**，差异仅在后端 infrastructure。

---

## 四、核心抽象：IAgentCore 接口

### 4.1 接口定义

所有 agent core 适配器必须实现以下契约：

```python
# platform/app/agent_core/interfaces.py

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import Callable, AsyncIterator
from pathlib import Path

class BackendType(Enum):
    SHARED_OPENCLAW = "shared_openclaw"
    DEDICATED_OPENCLAW = "dedicated_openclaw"
    CLAUDE_CODE = "claude_code"

@dataclass
class AgentConfig:
    name: str
    model: str
    personality: str | None = None  # SOUL.md content
    settings: dict | None = None

@dataclass
class AgentStatus:
    agent_id: str
    status: str  # creating / running / stopped / error
    sandbox_status: str | None = None  # for sandbox-based: running / stopped
    container_id: str | None = None

@dataclass
class Session:
    session_key: str
    created_at: datetime
    last_active_at: datetime
    message_count: int

@dataclass
class CoreEvent:
    event_type: str  # message / tool_call / tool_result / session_created / error / ...
    session_key: str
    content: Any
    metadata: dict  # timestamp, model, usage, etc.
    trace_id: str | None = None

@dataclass
class ResourceUsage:
    cpu_percent: float
    memory_mb: int
    sandbox_count: int
    active_sessions: int

@dataclass
class CoreInstanceInfo:
    instance_id: str
    backend_type: BackendType
    version: str
    region: str | None = None
    max_agents: int | None = None
    max_sandboxes: int | None = None

class IAgentCore(ABC):
    """
    Agent Engine 统一抽象接口。
    所有 backend 适配器必须实现此接口。
    """

    @property
    @abstractmethod
    def backend_type(self) -> BackendType:
        """Backend 类型标识"""
        ...

    @property
    @abstractmethod
    def instance_id(self) -> str:
        """全局唯一实例标识，格式: {backend_type}-{uuid[:8]}"""
        ...

    # ─── Agent 生命周期 ─────────────────────────────────────────

    @abstractmethod
    async def create_agent(self, config: AgentConfig) -> str:
        """
        在 backend 上创建 agent。
        Returns: backend 内的 agent_id
        Raises: AgentCreationError, BackendUnavailableError
        """
        ...

    @abstractmethod
    async def delete_agent(self, agent_id: str) -> None:
        """
        删除 agent 及其所有关联资源（sandbox, sessions, files）。
        """
        ...

    @abstractmethod
    async def get_agent_status(self, agent_id: str) -> AgentStatus:
        """查询 agent 状态"""
        ...

    # ─── 会话管理 ─────────────────────────────────────────────

    @abstractmethod
    async def send_message(
        self,
        agent_id: str,
        session_key: str,
        message: str,
        on_event: Callable[[CoreEvent], None] | None = None,
    ) -> None:
        """
        发送消息到 agent session。

        Args:
            agent_id: agent 标识
            session_key: 会话 key（格式由 backend 决定）
            message: 用户消息
            on_event: 事件回调，流式推送 events。
                      如果为 None，则等待完整响应后一次性返回。
        """
        ...

    @abstractmethod
    async def list_sessions(self, agent_id: str) -> list[Session]:
        """列出 agent 的所有会话"""
        ...

    @abstractmethod
    async def delete_session(self, agent_id: str, session_key: str) -> None:
        """删除指定会话"""
        ...

    @abstractmethod
    async def get_session_history(
        self, agent_id: str, session_key: str, limit: int | None = None
    ) -> list[dict]:
        """获取会话历史消息"""
        ...

    # ─── Workspace / Sandbox ────────────────────────────────────

    @abstractmethod
    async def get_workspace_path(self, agent_id: str) -> Path:
        """获取 agent workspace 路径"""
        ...

    @abstractmethod
    async def list_workspace_files(
        self, agent_id: str, path: str | None = None
    ) -> list[dict]:
        """
        列出 workspace 文件。
        Returns: [{name, type, size, modified_at, path}, ...]
        """
        ...

    @abstractmethod
    async def read_workspace_file(self, agent_id: str, path: str) -> bytes:
        """读取 workspace 文件内容"""
        ...

    @abstractmethod
    async def write_workspace_file(
        self, agent_id: str, path: str, content: bytes
    ) -> None:
        """写入 workspace 文件"""
        ...

    @abstractmethod
    async def delete_workspace_file(self, agent_id: str, path: str) -> None:
        """删除 workspace 文件"""
        ...

    @abstractmethod
    async def prune_sandbox(self, agent_id: str) -> None:
        """
        主动回收 agent 的 sandbox。
        仅对 sandbox-based backend 有意义，dedicated 模式可能为空操作。
        """
        ...

    # ─── Skills ─────────────────────────────────────────────────

    @abstractmethod
    async def list_skills(self, agent_id: str) -> list[dict]:
        """
        列出 agent 已安装的 skills。
        Returns: [{name, description, enabled, author}, ...]
        """
        ...

    @abstractmethod
    async def install_skill(self, agent_id: str, skill_name: str) -> None:
        """安装 skill 到 agent"""
        ...

    @abstractmethod
    async def uninstall_skill(self, agent_id: str, skill_name: str) -> None:
        """从 agent 卸载 skill"""
        ...

    # ─── 资源 & 健康 ───────────────────────────────────────────

    @abstractmethod
    async def get_resource_usage(self, agent_id: str) -> ResourceUsage:
        """获取 agent 资源使用情况"""
        ...

    @abstractmethod
    async def get_instance_info(self) -> CoreInstanceInfo:
        """获取 backend 实例元信息"""
        ...

    @abstractmethod
    async def health_check(self) -> bool:
        """Backend 健康检查"""
        ...
```

### 4.2 事件规范化

不同 backend 的事件格式统一规范为 `CoreEvent`：

```python
# platform/app/agent_core/events.py

class EventType(Enum):
    MESSAGE = "message"                    # 文本消息
    TOOL_CALL = "tool_call"                # 工具调用
    TOOL_RESULT = "tool_result"            # 工具结果
    TOOL_START = "tool_start"              # 工具开始执行
    TOOL_END = "tool_end"                  # 工具执行结束
    SESSION_CREATED = "session_created"    # 会话创建
    SESSION_DELETED = "session_deleted"    # 会话删除
    AGENT_STOPPED = "agent_stopped"        # Agent 停止
    ERROR = "error"                        # 错误
    STREAMING = "streaming"                # 流式片段（最终由 message 事件替代）
    DONE = "done"                          # 响应完成
```

每个 adapter 负责将 backend 原生事件格式转换为 `CoreEvent`，Platform 层完全不感知 backend 差异。

---

## 五、Tier 配置系统

### 5.1 配置结构

```yaml
# platform/config/tiers.yaml

tiers:
  free:
    backend: shared
    max_agents: 2
    max_sessions_per_agent: 10
    sandbox:
      mode: docker
      scope: agent
      memory: "2g"
      cpus: 2
      prune_idle_hours: 2
    features:
      skills: true
      knowledge_base: false
      cron_jobs: false
      channels: false
    quota:
      daily_tokens: 20_000_000  # 20M

  basic:
    backend: shared
    max_agents: 5
    max_sessions_per_agent: 50
    sandbox:
      mode: docker
      scope: agent
      memory: "2g"
      cpus: 2
      prune_idle_hours: 4
    features:
      skills: true
      knowledge_base: true
      cron_jobs: true
      channels: false
    quota:
      daily_tokens: 100_000_000  # 100M

  pro:
    backend: dedicated
    max_agents: 20
    max_sessions_per_agent: unlimited
    container:
      image: "openclaw:latest"
      memory: "4g"
      cpus: 2
      pids_limit: 512
      auto_stop_hours: 24  # 空闲 24h 后停止容器
      auto_destroy_days: 90  # 90 天未使用则销毁（保留数据）
    features:
      skills: true
      knowledge_base: true
      cron_jobs: true
      channels: true
      api_access: true
    quota:
      daily_tokens: 1_000_000_000  # 1B

  enterprise:
    backend: dedicated
    max_agents: unlimited
    max_sessions_per_agent: unlimited
    container:
      image: "openclaw:latest"
      memory: "8g"
      cpus: 4
      pids_limit: 1024
      auto_stop_hours: 168  # 1 周
      auto_destroy_days: 365
    features:
      skills: true
      knowledge_base: true
      cron_jobs: true
      channels: true
      api_access: true
      custom_sandbox: true
    quota:
      daily_tokens: unlimited
```

### 5.2 配置读取

```python
# platform/app/config/tiers.py

from dataclasses import dataclass
from pathlib import Path
import yaml

@dataclass
class SandboxConfig:
    mode: str = "docker"
    scope: str = "agent"
    memory: str = "2g"
    cpus: int = 2
    prune_idle_hours: int = 2

@dataclass
class ContainerConfig:
    image: str = "openclaw:latest"
    memory: str = "4g"
    cpus: int = 2
    pids_limit: int = 512
    auto_stop_hours: int = 24
    auto_destroy_days: int = 90

@dataclass
class TierConfig:
    name: str
    backend: str  # shared | dedicated
    max_agents: int | None
    max_sessions_per_agent: int | None
    sandbox: SandboxConfig | None = None
    container: ContainerConfig | None = None
    features: dict[str, bool] | None = None
    quota: dict[str, int | None] | None = None

class TierConfigManager:
    """Tier 配置管理器"""

    def __init__(self, config_path: Path | None = None):
        self.config_path = config_path or Path(__file__).parent / "tiers.yaml"
        self._tiers: dict[str, TierConfig] = {}
        self._load()

    def _load(self):
        with open(self.config_path) as f:
            raw = yaml.safe_load(f)
        for name, cfg in raw.get("tiers", {}).items():
            self._tiers[name] = TierConfig(name=name, **cfg)

    def get_tier(self, tier_name: str) -> TierConfig:
        return self._tiers.get(tier_name, self._tiers["free"])

    def get_all_tiers(self) -> dict[str, TierConfig]:
        return self._tiers.copy()
```

---

## 六、AgentCoreRouter

### 6.1 核心路由逻辑

```python
# platform/app/agent_core/router.py

from app.agentcore.interfaces import IAgentCore, BackendType
from app.agentcore.adapters import (
    SharedOpenClawAdapter,
    DedicatedOpenClawAdapter,
)
from app.agentcore.config import TierConfigManager

class AgentCoreRouter:
    """
    统一路由层。
    根据 user_id 查 tier → tier 决定 backend 类型 → 返回对应 adapter。
    """

    def __init__(
        self,
        tier_config: TierConfigManager,
        shared_adapter: SharedOpenClawAdapter,
        dedicated_factory: type[DedicatedOpenClawAdapter] | None = None,
    ):
        self.tier_config = tier_config
        self.shared_adapter = shared_adapter

        # dedicated adapter 池：per-user 实例
        self._dedicated_adapters: dict[str, DedicatedOpenClawAdapter] = {}
        self._dedicated_factory = dedicated_factory or DedicatedOpenClawAdapter

    async def get_adapter(self, user_id: str) -> IAgentCore:
        """获取用户对应的 agent core adapter"""
        tier_name = await self._get_user_tier(user_id)
        tier = self.tier_config.get_tier(tier_name)

        if tier.backend == "shared":
            return self.shared_adapter

        elif tier.backend == "dedicated":
            if user_id not in self._dedicated_adapters:
                adapter = await self._provision_dedicated(user_id, tier)
                self._dedicated_adapters[user_id] = adapter
            return self._dedicated_adapters[user_id]

        # fallback
        return self.shared_adapter

    async def _get_user_tier(self, user_id: str) -> str:
        """从 DB 查用户的 tier"""
        # from platform.app.db import ...
        # user = await db.get_user(user_id)
        # return user.quota_tier
        ...

    async def _provision_dedicated(
        self, user_id: str, tier: TierConfig
    ) -> DedicatedOpenClawAdapter:
        """为用户分配 dedicated adapter（可能涉及容器创建）"""
        adapter = self._dedicated_factory(
            user_id=user_id,
            tier=tier,
        )
        await adapter.initialize()
        return adapter

    async def get_adapter_for_agent(self, user_id: str, agent_id: str) -> IAgentCore:
        """获取指定 agent 所在的 adapter"""
        return await self.get_adapter(user_id)

    # ─── 统一操作入口 ─────────────────────────────────────────

    async def create_agent(
        self, user_id: str, config: AgentConfig
    ) -> str:
        adapter = await self.get_adapter(user_id)
        return await adapter.create_agent(config)

    async def send_message(
        self,
        user_id: str,
        agent_id: str,
        session_key: str,
        message: str,
        on_event: Callable[[CoreEvent], None] | None = None,
    ) -> None:
        adapter = await self.get_adapter(user_id)
        await adapter.send_message(agent_id, session_key, message, on_event)

    # ... 其他操作同上，统一通过 router 代理
```

### 6.2 使用方式

Platform Gateway 的 route handler 完全不需要知道用户是哪个 tier：

```python
# platform/app/routes/agents.py

from app.agentcore.router import AgentCoreRouter

router = AgentCoreRouter(...)

@router.post("/agents")
async def create_agent(user_id: str, body: AgentCreate):
    config = AgentConfig(name=body.name, model=body.model, ...)
    agent_id = await router.create_agent(user_id, config)
    return {"agent_id": agent_id}

@router.websocket("/ws/{agent_id}")
async def chat_ws(agent_id: str, session_key: str, user_id: str):
    async def on_event(event: CoreEvent):
        await websocket.send_json(event_to_dict(event))

    await router.send_message(user_id, agent_id, session_key, "", on_event)
```

---

## 七、Adapter 实现

### 7.1 SharedOpenClawAdapter

复用现有 bridge 逻辑，封装为 `IAgentCore` 接口：

```python
# platform/app/agent_core/adapters/shared.py

class SharedOpenClawAdapter(IAgentCore):
    """
    封装现有 bridge，实现 IAgentCore。
    复用 /agents, /sessions, /skills, /files 等 API。
    """

    backend_type = BackendType.SHARED_OPENCLAW
    instance_id = "shared-openclaw-1"

    def __init__(self, bridge_url: str, bridge_token: str):
        self.bridge_url = bridge_url
        self.bridge_token = bridge_token
        self._http = httpx.AsyncClient(timeout=30.0)
        self._ws_manager = WebSocketManager()

    async def create_agent(self, config: AgentConfig) -> str:
        resp = await self._http.post(
            f"{self.bridge_url}/agents",
            json={"name": config.name, "model": config.model, "soul_md": config.personality},
            headers=self._auth_headers(),
        )
        resp.raise_for_status()
        return resp.json()["id"]

    async def send_message(
        self,
        agent_id: str,
        session_key: str,
        message: str,
        on_event: Callable[[CoreEvent], None] | None = None,
    ) -> None:
        scoped_session = f"agent:{agent_id}:{session_key}"

        if on_event:
            ws = await self._ws_manager.connect(agent_id)
            await ws.send(json.dumps({
                "type": "req", "method": "chat.send",
                "params": {"sessionKey": scoped_session, "message": message}
            }))
            async for raw in ws:
                event = self._normalize_event(raw)
                on_event(event)
        else:
            resp = await self._http.post(
                f"{self.bridge_url}/chat/send",
                json={"agentId": agent_id, "sessionKey": scoped_session, "message": message},
                headers=self._auth_headers(),
            )
            resp.raise_for_status()

    def _normalize_event(self, raw: dict) -> CoreEvent:
        """将 bridge WS 事件规范化为 CoreEvent"""
        event_map = {
            "chat.message.received": EventType.MESSAGE,
            "chat.tool.call": EventType.TOOL_CALL,
            "chat.tool.result": EventType.TOOL_RESULT,
            "session.created": EventType.SESSION_CREATED,
            "error": EventType.ERROR,
        }
        return CoreEvent(
            event_type=event_map.get(raw.get("event", ""), EventType.STREAMING),
            session_key=raw.get("payload", {}).get("sessionKey", ""),
            content=raw.get("payload", {}).get("content", ""),
            metadata=raw.get("payload", {}).get("metadata", {}),
        )

    # ... 其他方法类似，委托给现有 bridge API

    async def health_check(self) -> bool:
        resp = await self._http.get(f"{self.bridge_url}/status")
        return resp.status_code == 200
```

### 7.2 DedicatedOpenClawAdapter

per-user 独立 OpenClaw 容器封装：

```python
# platform/app/agent_core/adapters/dedicated.py

class DedicatedOpenClawAdapter(IAgentCore):
    """
    管理单个用户（user_id）的独立 OpenClaw 容器。
    每个 user_id 对应一个 DedicatedOpenClawAdapter 实例。
    """

    backend_type = BackendType.DEDICATED_OPENCLAW

    def __init__(
        self,
        user_id: str,
        tier: TierConfig,
        container_manager: "DedicatedContainerManager",
    ):
        self.user_id = user_id
        self.instance_id = f"dedicated-{user_id}"
        self.tier = tier
        self.container_manager = container_manager
        self._bridge_url: str | None = None
        self._http: httpx.AsyncClient | None = None

    async def initialize(self) -> None:
        """容器启动或复用已有容器"""
        info = await self.container_manager.ensure_running(self.user_id, self.tier)
        self._bridge_url = info.bridge_url
        self._http = httpx.AsyncClient(base_url=self._bridge_url, timeout=30.0)

    async def create_agent(self, config: AgentConfig) -> str:
        # 在独立 OpenClaw 上创建 agent
        resp = await self._http.post("/agents", json={...})
        return resp.json()["id"]

    async def send_message(self, ...):
        # 确保容器运行
        await self.container_manager.ensure_running(self.user_id, self.tier)
        ...

    async def delete_agent(self, agent_id: str) -> None:
        ...

    async def health_check(self) -> bool:
        try:
            resp = await self._http.get("/status")
            return resp.status_code == 200
        except Exception:
            return False
```

---

## 八、Dedicated 容器管理

### 8.1 容器生命周期

```
用户首次使用 Pro tier
    │
    ▼
DedicatedContainerManager.ensure_running()
    ├─ DB 占位：containers 表插入记录（防并发）
    ├─ Docker API: 创建容器（如果不存在）
    │    ├─ 镜像: tier.container.image
    │    ├─ 资源限制: memory / cpus / pids_limit
    │    ├─ 环境变量注入: proxy_url / token / model
    │    └─ Volume 挂载: workspace / sessions
    ├─ 启动容器
    ├─ 等待 Bridge 就绪（HTTP probe）
    └─ 返回 bridge_url

空闲 N 小时（tier.auto_stop_hours）
    ▼
container_manager.stop(user_id)
    ├─ Docker pause
    └─ 更新 DB: containers.status = "stopped"

用户再次访问
    ▼
container_manager.ensure_running()
    ├─ Docker unpause（秒级恢复）
    └─ 验证 Bridge 就绪

用户删除 / 空闲 N 天（tier.auto_destroy_days）
    ▼
container_manager.destroy(user_id)
    ├─ Docker stop + rm
    ├─ 删除 volumes
    └─ 删除 DB 记录
```

### 8.2 DedicatedContainerManager

```python
# platform/app/container/dedicated_manager.py

import asyncio
import httpx
from dataclasses import dataclass
from datetime import datetime, timedelta

import docker

@dataclass
class ContainerInfo:
    container_id: str
    bridge_url: str      # e.g. "http://172.17.0.x:18080"
    gateway_ws_url: str  # e.g. "ws://172.17.0.x:18789"
    status: str          # creating / running / stopped / error
    created_at: datetime
    last_active_at: datetime

class DedicatedContainerManager:
    """
    管理所有 dedicated OpenClaw 容器。
    职责：创建 / 启动 / 停止 / 销毁 / 健康检查。
    """

    def __init__(
        self,
        docker_client: docker.DockerClient,
        network_name: str = "openclaw-internal",
        probe_timeout: int = 120,
    ):
        self.docker = docker_client
        self.network_name = network_name
        self.probe_timeout = probe_timeout
        self._locks: dict[str, asyncio.Lock] = {}  # per-user lock
        self._container_cache: dict[str, ContainerInfo] = {}

    async def ensure_running(
        self, user_id: str, tier: TierConfig
    ) -> ContainerInfo:
        """确保用户容器运行，返回 ContainerInfo"""
        async with self._get_lock(user_id):
            info = await self._get_container_info(user_id)

            if info and info.status == "running":
                await self._update_last_active(user_id)
                return info

            if info and info.status == "stopped":
                return await self._start_container(user_id, tier)

            # 不存在则创建
            return await self._create_container(user_id, tier)

    async def _create_container(
        self, user_id: str, tier: TierConfig
    ) -> ContainerInfo:
        """创建新容器"""
        container_name = f"openclaw-user-{user_id}"

        # 资源限制
        memory = tier.container.memory
        cpus = tier.container.cpus

        # 生成容器 token（用于 LLM 代理认证）
        container_token = secrets.token_urlsafe(32)

        # 创建 Docker volume（workspace + sessions）
        workspace_vol = f"openclaw-workspace-{user_id}"
        sessions_vol = f"openclaw-sessions-{user_id}"

        for vol_name in [workspace_vol, sessions_vol]:
            try:
                self.docker.volume.create(name=vol_name)
            except docker.errors.APIError:
                pass  # 已存在

        # 容器环境变量
        env = [
            f"NANOBOT_PROXY__URL=http://platform-gateway:8080",
            f"NANOBOT_PROXY__TOKEN={container_token}",
            "DEFAULT_MODEL=dashscope/qwen3-coder-plus",
            "OPENCLAW_VERSION=2026.3.8",
        ]

        # 创建容器（不启动，等待网络分配）
        container = self.docker.containers.run(
            image=tier.container.image,
            name=container_name,
            detach=True,
            mem_limit=memory,
            nano_cpus=int(cpus * 1e9),
            pids_limit=tier.container.pids_limit,
            environment=env,
            volumes={
                workspace_vol: {"bind": "/data/openclaw-workspace", "mode": "rw"},
                sessions_vol: {"bind": "/data/openclaw-sessions", "mode": "rw"},
            },
            network=self.network_name,
            restart_policy={"Name": "unless-stopped"},
            remove=False,
        )

        # 等待网络分配，获取 IP
        await self._wait_for_network(container)

        container_info = ContainerInfo(
            container_id=container.id,
            bridge_url=f"http://{self._get_container_ip(container)}:18080",
            gateway_ws_url=f"ws://{self._get_container_ip(container)}:18789",
            status="creating",
            created_at=datetime.utcnow(),
            last_active_at=datetime.utcnow(),
        )

        # 等待 Bridge HTTP 就绪
        await self._probe_bridge(container_info.bridge_url)
        container_info.status = "running"

        # 写入 DB
        await self._save_container_info(user_id, container_info, container_token)

        self._container_cache[user_id] = container_info
        return container_info

    async def _start_container(
        self, user_id: str, tier: TierConfig
    ) -> ContainerInfo:
        """恢复已暂停的容器"""
        container = self.docker.containers.get(f"openclaw-user-{user_id}")
        container.unpause()

        info = self._container_cache[user_id]
        info.status = "creating"

        await self._probe_bridge(info.bridge_url)
        info.status = "running"
        info.last_active_at = datetime.utcnow()

        await self._update_container_status(user_id, info)
        return info

    async def stop(self, user_id: str) -> None:
        """暂停容器"""
        container_name = f"openclaw-user-{user_id}"
        try:
            container = self.docker.containers.get(container_name)
            container.pause()
            await self._update_container_status(user_id, "stopped")
        except docker.errors.NotFound:
            pass

    async def destroy(self, user_id: str) -> None:
        """销毁容器及关联资源"""
        async with self._get_lock(user_id):
            container_name = f"openclaw-user-{user_id}"

            try:
                container = self.docker.containers.get(container_name)
                container.stop(timeout=10)
                container.remove(v=True)
            except docker.errors.NotFound:
                pass

            # 删除 volumes
            for vol_name in [f"openclaw-workspace-{user_id}", f"openclaw-sessions-{user_id}"]:
                try:
                    self.docker.volumes.get(vol_name).remove()
                except docker.errors.NotFound:
                    pass

            # 删除 DB 记录
            await self._delete_container_record(user_id)
            self._container_cache.pop(user_id, None)

    async def _probe_bridge(self, bridge_url: str, timeout: int = 120) -> bool:
        """等待 Bridge HTTP 服务就绪"""
        async with httpx.AsyncClient() as client:
            start = asyncio.get_event_loop().time()
            while asyncio.get_event_loop().time() - start < timeout:
                try:
                    resp = await client.get(f"{bridge_url}/status")
                    if resp.status_code == 200:
                        return True
                except httpx.RequestError:
                    pass
                await asyncio.sleep(2)
        raise TimeoutError(f"Bridge not ready at {bridge_url} after {timeout}s")

    # ─── 定时任务：自动停止 & 销毁 ──────────────────────────────

    async def run_idle_checker(self, interval_hours: int = 1) -> None:
        """
        后台定时任务：
        - 检查空闲超时的 running 容器 → stop
        - 检查空闲超时的 stopped 容器 → destroy
        """
        while True:
            await asyncio.sleep(interval_hours * 3600)

            for user_id, info in list(self._container_cache.items()):
                tier = self.tier_config.get_tier(await self._get_user_tier(user_id))

                idle_hours = (datetime.utcnow() - info.last_active_at).total_seconds() / 3600

                if info.status == "running" and idle_hours >= tier.container.auto_stop_hours:
                    await self.stop(user_id)

                elif info.status == "stopped" and idle_hours >= tier.container.auto_destroy_days * 24:
                    await self.destroy(user_id)
```

---

## 九、Database 模型变更

### 9.1 User 表

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS quota_tier VARCHAR(20) DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_core_type VARCHAR(50) DEFAULT 'openclaw';
```

### 9.2 Agent 表

```sql
ALTER TABLE user_agents ADD COLUMN IF NOT EXISTS backend_type VARCHAR(50) DEFAULT 'shared_openclaw';
ALTER TABLE user_agents ADD COLUMN IF NOT EXISTS backend_instance_id VARCHAR(100);
```

### 9.3 Container 表（已有，新增字段）

```sql
ALTER TABLE containers ADD COLUMN IF NOT EXISTS tier VARCHAR(20) DEFAULT 'pro';
ALTER TABLE containers ADD COLUMN IF NOT EXISTS auto_stop_hours INTEGER DEFAULT 24;
ALTER TABLE containers ADD COLUMN IF NOT EXISTS auto_destroy_days INTEGER DEFAULT 90;
```

---

## 十、安全设计

### 10.1 共享 vs 独立的安全差异

| 安全层面 | 共享模式 | 独立模式 |
|---------|---------|---------|
| **进程隔离** | agent 间共享 OpenClaw 进程 | 独立 OpenClaw 进程 |
| **网络隔离** | 同 Bridge，不同 sandbox network namespace | 独立容器 network namespace |
| **文件系统** | `workspace-{agentId}/` 隔离 | `workspace-{userId}/` 隔离 |
| **LLM 访问** | LLM Proxy 统一注入 API Key | 同左，container_token 认证 |
| **故障域** | 单 OpenClaw 故障影响全部用户 | 单容器故障只影响该用户 |
| **资源竞争** | 共享 CPU/内存 | 独立 cgroup 限制 |

### 10.2 LLM Proxy 认证（独立容器）

独立容器的 OpenClaw 通过 container_token 向 LLM Proxy 认证：

```
Container 内 OpenClaw
  → POST http://gateway:8080/llm/v1/chat/completions
    Authorization: Bearer <container_token>

Gateway 验证:
  1. container_token → 查 containers 表
  2. containers.user_id → quota 检查
  3. 注入对应 provider 的 API Key
```

container_token 在容器创建时生成，存储于 DB，不暴露给用户。

### 10.3 Tier 升级的安全检查

用户从 free 升级到 pro 时：

1. Platform 检查目标 tier 的资源可用性
2. 为用户分配 dedicated container
3. 将 shared 模式下的 agents/sessions/skills 迁移到新容器
4. 旧 shared agent 记录标记为 migrated
5. 迁移完成后，shared agent 不再可用

---

## 十一、Tier 迁移流程

### 11.1 Free/Basic → Pro

```
用户触发升级
    │
    ▼
Platform 验证:
  ├─ 资源检查：是否有足够的物理节点容量
  ├─ 配额检查：目标 tier 是否在平台支持范围
  └─ 数据检查：迁移数据量预估
    │
    ▼
创建 dedicated 容器
    │
    ▼
数据迁移（后台）:
  ├─ agents → 新容器 /agents API
  ├─ sessions → 迁移 session 历史
  ├─ skills → 新容器 /skills/install
  ├─ workspace files → Docker volume copy
  └─ knowledge base → 同上
    │
    ▼
DNS/路由切换:
  └─ TenantRegistry 更新路由
    │
    ▼
旧 shared 数据保留 7 天（备份窗口）
    │
    ▼
清理旧 shared 数据
```

### 11.2 Pro → Free（降级）

降级需要用户确认：

1. 迁移 agent 配置为 free 兼容格式
2. sessions 保留（不迁移，付费数据保留）
3. 创建新的 shared agent 映射
4. 独立容器保留但停止（数据可恢复）
5. 30 天后未恢复则销毁

---

## 十二、与现有 Bridge 的关系

### 12.1 复用 vs 重写

| Bridge 模块 | 复用方式 |
|------------|---------|
| `agents.ts` | SharedOpenClawAdapter 委托 REST 调用 |
| `sessions.ts` | SharedOpenClawAdapter 委托 REST 调用 |
| `skills.ts` | SharedOpenClawAdapter 委托 REST 调用 |
| `filemanager.ts` | SharedOpenClawAdapter 委托 REST 调用 |
| `files.ts` | SharedOpenClawAdapter 委托 REST 调用 |
| `workspace.ts` | SharedOpenClawAdapter 委托 REST 调用 |
| `channels.ts` | SharedOpenClawAdapter 委托 REST 调用 |
| `cron.ts` | SharedOpenClawAdapter 委托 REST 调用 |
| `nodes.ts` | OpenClaw 特有，shared 模式下可用 |
| `marketplaces.ts` | Platform 能力，可抽取 |
| `plugins.ts` | OpenClaw 特有 |
| `commands.ts` | OpenClaw 特有 |
| `settings.ts` | OpenClaw 特有，shared 模式下可用 |
| `status.ts` | SharedOpenClawAdapter 复用 |
| `curated-skills.ts` | Platform 能力，可抽取 |
| `reviews.ts` | **纯平台逻辑**，复用 |
| `notifications.ts` | **纯平台逻辑**，复用 |

### 12.2 Bridge 代码位置

当前 bridge 代码在 `bridge/` 目录，SharedOpenClawAdapter 通过 HTTP 调用它，不需要移动或重写代码。

Dedicated 模式下，每个用户容器内运行完整 bridge，代码完全一致，只需在容器启动时注入不同配置。

---

## 十三、未来扩展：Claude Code Adapter

### 13.1 接口适配

Claude Code Adapter 实现相同的 `IAgentCore` 接口，但底层调用 Claude Code 的 API：

```python
class ClaudeCodeAdapter(IAgentCore):
    backend_type = BackendType.CLAUDE_CODE

    async def create_agent(self, config: AgentConfig) -> str:
        # Claude Code 的 agent 创建逻辑
        ...

    async def send_message(self, ...):
        # Claude Code 的 chat API
        ...
```

### 13.2 能力映射

| IAgentCore 能力 | Claude Code 支持 | 适配方式 |
|----------------|-----------------|---------|
| create_agent | `claude code` CLI | subprocess 调用 |
| send_message | MCP 协议 / API | MCP server 连接 |
| list_sessions | 会话文件 | 读取 `~/.claude/sessions/` |
| skills | MCP tools | 映射为 MCP tool 调用 |
| workspace | 项目目录 | 文件系统操作 |

---

## 十四、文件变更清单

```
platform/app/
├── agentcore/                      # NEW: 核心抽象层 (避开了 stdlib `platform` 冲突)
│   ├── __init__.py
│   ├── interfaces.py              # IAgentCore 接口定义
│   ├── router.py                   # AgentCoreRouter
│   ├── adapters/                   # Adapter 实现
│   │   ├── __init__.py
│   │   ├── shared.py             # SharedOpenClawAdapter
│   │   └── dedicated.py           # DedicatedOpenClawAdapter (Phase 2)
│   └── config/
│       ├── __init__.py
│       ├── tiers.py               # TierConfigManager
│       └── tiers.yaml             # Tier 配置
└── ...existing routes unchanged...
```

---

## 十五、实现计划

### Phase 0: 接口抽象（不改行为）

- [ ] 定义 `IAgentCore` 接口 + `CoreEvent` 事件规范
- [ ] 实现 `SharedOpenClawAdapter`，委托给现有 bridge HTTP API
- [ ] 实现 `TierConfigManager`，加载 `tiers.yaml`
- [ ] 实现 `AgentCoreRouter`，默认全走 shared adapter
- [ ] 修改现有 route handlers 通过 router 代理
- [ ] **验证**：所有现有功能不受影响

### Phase 1: Tier 配置化

- [ ] DB 迁移：`users.quota_tier`
- [ ] `DedicatedContainerManager` 骨架（create / stop / destroy）
- [ ] Admin 界面：用户 tier 管理
- [ ] **验证**：Admin 可修改用户 tier

### Phase 2: Dedicated 基础设施

- [ ] 完整 `DedicatedContainerManager` 实现
- [ ] `DedicatedOpenClawAdapter` 实现
- [ ] LLM Proxy 支持 container_token 认证
- [ ] 后台 idle checker 定时任务
- [ ] **验证**：Pro 用户有独立容器

### Phase 3: 数据迁移

- [ ] Free → Pro 迁移流程
- [ ] Pro → Free 降级流程
- [ ] 迁移过程的用户体验（进度条/通知）
- [ ] **验证**：迁移后数据完整

### Phase 4: 生产化

- [ ] Tier 灰度：先开放 admin 用户 pro
- [ ] 资源监控 dashboard
- [ ] 多节点支持（Placement 策略）
- [ ] **验证**：生产稳定运行

### Phase 5: Claude Code Adapter（未来）

- [ ] Claude Code Adapter 接口实现
- [ ] Tier 配置支持 `agent_core` 字段
- [ ] **验证**：Claude Code tier 可用

---

## 十六、Open Questions

以下问题需要在实现前确认：

1. **Dedicated 容器调度**：多台物理节点时，用户容器放在哪个节点？K8s？静态配置？
2. **Skill/Knowledge 跨 Tier 共享**：Free 用户安装的 skill，升级 Pro 后是否保留？
3. **容器 IP 分配**：Docker 默认 bridge 网络 IP 不固定，如何稳定路由？
4. **迁移原子性**：数据迁移中途失败如何回滚？
5. **多实例 OpenClaw 同步**：Pro 用户有多个 agent 时，跨 agent 通信是否需要支持？
