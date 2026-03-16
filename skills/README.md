# Project Skills

把你的自定义技能放在这里，容器启动时会自动复制到全局 skills 目录，在**平台技能**板块中供所有用户使用。

## 当前技能列表

本目录包含以下 Claude Code 官方开源技能：

| 技能 | 描述 |
|------|------|
| `claude-api` | 使用 Claude API 构建应用 |
| `docx` | Word 文档处理 |
| `pptx` | PowerPoint 演示文稿处理 |
| `pdf` | PDF 文档处理 |
| `xlsx` | Excel 表格处理 |
| `canvas-design` | Canvas 设计生成 |
| `frontend-design` | 前端设计开发 |
| `webapp-testing` | Web 应用测试 |
| `web-artifacts-builder` | Web 产物构建 |
| `mcp-builder` | MCP (Model Context Protocol) 构建 |
| `algorithmic-art` | 算法艺术生成 |
| `theme-factory` | 主题工厂 |
| `slack-gif-creator` | Slack GIF 制作 |
| `brand-guidelines` | 品牌指南 |
| `internal-comms` | 内部通讯 |
| `doc-coauthoring` | 文档协作编写 |
| `skill-creator` | 技能创建助手 |

来源：[Claude Code Skills](https://github.com/anthropics/claude-code-skills)

## 目录结构

```
skills/
├── skill-creator/          # 自定义 skill-creator（优先使用，替代内置版本）
│   ├── SKILL.md
│   └── scripts/
├── my-custom-skill/        # 你的其他技能
│   ├── SKILL.md
│   └── scripts/
└── README.md
```

## 规则

1. **skill-creator**: 如果有，会完全替代 OpenClaw 内置的版本
2. **其他技能**: 会复制到全局 skills，所有用户都能看到和使用
3. **命名**: 目录名就是技能名（小写，用连字符分隔）

## 示例

创建新技能最简单的方式是让 skill-creator 帮你生成：

```bash
cd skills
npx skill-creator init my-new-skill
```

或者直接手动创建：

```bash
mkdir -p my-skill/scripts
cat > my-skill/SKILL.md << 'SKILL'
# my-skill

简介...

## 使用

```bash
python3 scripts/main.py
```
SKILL

touch my-skill/scripts/main.py
```
