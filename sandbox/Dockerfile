# AgentClaw Sandbox Image - 国内优化版
# 基于 Node.js 官方镜像（已预装 Node.js 20），加装 Python 和常用工具
#
# 构建：docker build -t openclaw-sandbox:agentclaw ./sandbox/

FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

# 替换为阿里云镜像源
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources

# 安装 Python + 常用工具（单层）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    curl wget jq ripgrep git \
    && rm -rf /var/lib/apt/lists/*

# pip 使用阿里云镜像
RUN pip3 config set global.index-url https://mirrors.aliyun.com/pypi/simple/

# 常用 Python 包
RUN pip3 install --break-system-packages \
    requests httpx beautifulsoup4 lxml

# npm 使用淘宝镜像
RUN npm config set registry https://registry.npmmirror.com

# 预装 pnpm
RUN npm install -g pnpm

# 创建 sandbox 用户
RUN useradd --create-home --shell /bin/bash sandbox

WORKDIR /workspace

CMD ["sleep", "infinity"]
