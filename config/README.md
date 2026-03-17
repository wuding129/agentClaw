# AgentClaw 配置目录

这个目录存放 AgentClaw 平台的配置文件和智能体角色设定。

## 文件说明

| 文件 | 用途 | 是否必须 |
|------|------|---------|
| `SOUL.md` | Agent 身份与人格（每次对话都读取） | 必须 |
| `AGENTS.md` | Agent 行为规范（记忆系统、工作方式、红线规则） | 可选，不存在则使用 OpenClaw 默认 |

## SOUL.md 格式

OpenClaw 使用 SOUL.md 作为智能体的角色定义文件，格式如下：

```yaml
---
read_when:
  - always
summary: 简短描述
---

# 你是 XXX

角色定义内容...
```

- `read_when: always` - 每次对话都读取此文件
- `summary` - 简短摘要，用于上下文管理
- 正文 - 角色的详细设定、行为规则、工作流等

## 修改配置

直接编辑对应文件，修改后重启服务生效：

```bash
docker compose restart gateway
```

**注意：** 现有用户的 Agent 文件不会自动更新，仅对新注册用户生效。

如需同步到现有 Agent，可手动调用 bridge API 或重新创建用户。

## 部署定制（白标化）

不同的产品实例替换这两个文件即可定制 Agent 形态：

```
config/
  SOUL.md     # 定义 Agent 是谁（品牌、人格、工作流）
  AGENTS.md   # 定义 Agent 怎么工作（可选覆盖 OpenClaw 默认）
```

例如 SkillClaw 部署：
- `SOUL.md` → "你是 SkillClaw，技能创作助手"
- `AGENTS.md` → 精简版，去掉群聊规则，强调技能开发工作流
