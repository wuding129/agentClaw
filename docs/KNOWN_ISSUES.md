# 已知问题 & 待完成功能

## 🔴 未完成

### 第三方技能安装（skills.sh）不落地到 workspace

**现象**：在「技能搜索」页搜索并点击安装第三方技能（来自 skills.sh），显示安装成功，但技能不出现在「已安装」列表，文件管理器也看不到。

**根本原因**：
`skills add -g` 会把技能装到 `$HOME/.openclaw/skills/`（容器内是 `/root/.openclaw/skills/`），而平台的实际数据在 `OPENCLAW_HOME=/Users/wu/.openclaw`（宿主机 bind mount）。两个路径不同，snapshot + rename 的逻辑无法从容器内 `/root/.openclaw/skills/` 取到内容再移到用户 workspace。

**涉及文件**：`bridge/routes/marketplaces.ts` — `POST /api/marketplaces/skills/install`

**可能的修复方向**：
1. 在用户沙盒容器内执行 `npx skills add`（沙盒的 workspace 已挂载为工作目录，不带 `-g` 就能装到正确位置）— 需要通过 Docker API exec 进沙盒容器，沙盒可能未运行时需先启动
2. 用 Agent 在聊天里自己运行 `skills add`（绕过 UI 安装，直接让 Agent 帮装）
3. 修改 `skills` CLI 安装路径（暂无文档支持自定义 global 路径）

---

## 🟡 功能占位 / 降级实现

### 技能提交 AI 自动审核

**现象**：用户提交技能后，AI 审核步骤跳过，直接等待管理员手动审核。

**位置**：`platform/app/routes/skills.py` — `_ai_review_skill()` 函数返回 `None`

**说明**：框架已搭好（`ReviewTask` 表、`skill-reviewer` agent、审核队列接口都在），只差把 LLM 调用接进去。

---

### URL 提交技能不拉取 SKILL.md

**现象**：用户通过 source_url 提交技能时，平台不会去拉取 SKILL.md 内容，无法触发 AI 审核。

**位置**：`platform/app/routes/skills.py` — `submit_skill()` 里的 TODO

---

### Dashboard 数据待确认

**现象**：仪表盘统计数据（用户数、会话数、Agent 数等）需确认是读取真实数据库还是硬编码。

**位置**：`platform/app/routes/admin.py` 对应接口 + `frontend/src/pages/Dashboard.tsx`

---

### AuditLog 页面未接入

**现象**：`frontend/src/pages/AuditLog.tsx` 存在但未加入路由，内部使用硬编码 mock 数据，没有实际 API 调用。

**说明**：DB 中有 `AuditLog` 模型，后端数据已有，前端页面需要重写并注册路由。

---

## ✅ 近期修复记录

| 时间 | 问题 | 修复 |
|------|------|------|
| 2026-03-17 | 技能管理待审核详情为空 | 后端补全 `file_path`/`ai_review_result` 字段返回；新增 `/content` 接口读 SKILL.md；前端加展开详情、AI 审核结果展示 |
| 2026-03-17 | 精选技能安装 404 `Skill files not found` | `install_curated_skill` 用了 `user.id` 而非 `openclaw_agent_id`；本地文件不存在时缺少 fallback |
| 2026-03-17 | 沙盒报错 `Sandbox image not found: openclaw-sandbox:agentclaw` | 镜像 tag 从 `skillclaw` 改名后未重新 tag，执行 `docker tag` 修复 |
| 2026-03-17 | 选择供应商弹窗透明 | `bg-bg-overlay` Tailwind v4 循环变量 bug，改为 `bg-black/40` |
| 2026-03-17 | 全站样式丢失（仪表盘只剩线条） | 批量迁移旧暗色 class（`bg-dark-card` 等）到双主题 CSS 变量 |
