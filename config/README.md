# AgentClaw 配置目录

这个目录存放 AgentClaw 平台的配置文件和智能体角色设定。

## 文件说明

| 文件 | 用途 |
|------|------|
| `SOUL.md` | AgentClaw 平台的默认智能体角色设定（SOUL.md 格式） |

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

## 修改角色设定

直接编辑 `SOUL.md` 文件，修改后重启服务生效：

```bash
docker compose restart gateway openclaw-shared
```

现有用户的 SOUL.md 不会自动更新，需要手动同步或重新创建用户。

## 添加新角色（高级）

如需为不同用户类型配置不同角色：

1. 在此目录创建新的 `.md` 文件
2. 修改 `platform/app/personas/__init__.py` 添加加载函数
3. 在相关代码中引用新角色
