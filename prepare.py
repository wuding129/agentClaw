#!/usr/bin/env python3
"""AgentClaw 环境准备脚本（跨平台：macOS / Linux / Windows）。

检查并自动准备 docker-compose 部署所需的环境：
  1. Docker 守护进程运行状态
  2. Docker 镜像 (postgres, openclaw 相关)
  3. .env 环境变量配置

用法:
  python prepare.py           # 检查并自动修复
  python prepare.py --check   # 仅检查，不自动修复
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path

# ── 平台检测 ──────────────────────────────────────────────────────────
IS_WINDOWS = sys.platform == "win32"

# ── 颜色输出 ──────────────────────────────────────────────────────────
if IS_WINDOWS:
    import ctypes
    try:
        ctypes.windll.kernel32.SetConsoleMode(
            ctypes.windll.kernel32.GetStdHandle(-11), 7
        )
        _COLOR = True
    except Exception:
        _COLOR = False
else:
    _COLOR = True

def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _COLOR else text

GREEN  = lambda s: _c("32", s)
RED    = lambda s: _c("31", s)
YELLOW = lambda s: _c("33", s)
CYAN   = lambda s: _c("36", s)
BOLD   = lambda s: _c("1",  s)
DIM    = lambda s: _c("2",  s)

PROJECT_DIR  = Path(__file__).parent.resolve()

# ── 输出工具 ──────────────────────────────────────────────────────────

def info(msg: str):
    print(f"  {CYAN('ℹ')} {msg}")

def ok(msg: str):
    print(f"  {GREEN('✓')} {msg}")

def warn(msg: str):
    print(f"  {YELLOW('⚠')} {msg}")

def fail(msg: str):
    print(f"  {RED('✗')} {msg}")

def step(title: str):
    print(f"\n{BOLD(title)}")

def run(*cmd, cwd=None, capture=True) -> "subprocess.CompletedProcess":
    return subprocess.run(
        list(cmd),
        cwd=str(cwd) if cwd else None,
        capture_output=capture,
        text=True,
    )


# ── 检查项定义 ────────────────────────────────────────────────────────

class CheckResult:
    def __init__(self, passed: bool, detail: str = "", fixed: bool = False):
        self.passed = passed
        self.detail = detail
        self.fixed  = fixed


def check_docker_running() -> CheckResult:
    """Docker 守护进程是否运行。"""
    r = run("docker", "info")
    if r.returncode == 0:
        return CheckResult(True)
    return CheckResult(
        False,
        "Docker 未运行（请手动启动 Docker Desktop 或 dockerd 后重试）",
    )


def check_docker_image(image: str, fix: bool) -> CheckResult:
    """检查 Docker 镜像是否已拉取；若未拉取则 docker pull。"""
    r = run("docker", "images", "-q", image)
    if r.returncode == 0 and r.stdout.strip():
        return CheckResult(True, image)

    if not fix:
        return CheckResult(False, f"镜像 {image} 未找到")

    info(f"正在拉取 {image} ...")
    r = run("docker", "pull", image, capture=False)
    if r.returncode == 0:
        return CheckResult(True, image, fixed=True)
    return CheckResult(False, f"拉取 {image} 失败（exit {r.returncode}）")


ENV_FILE     = PROJECT_DIR / ".env"
ENV_EXAMPLE  = PROJECT_DIR / ".env.example"

# .env 中所有已知的 API Key 变量名
_ALL_API_KEYS = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
    "DASHSCOPE_API_KEY",
    "AIHUBMIX_API_KEY",
    "MOONSHOT_API_KEY",
    "KIMI_API_KEY",
    "ZHIPU_API_KEY",
    "HOSTED_VLLM_API_KEY",
    "BRAVE_API_KEY",
    "PERPLEXITY_API_KEY",
]


def _parse_env_file(path: Path) -> dict[str, str]:
    """解析 .env 文件，返回 {KEY: VALUE} 字典（忽略注释和空行）。"""
    result = {}
    if not path.exists():
        return result
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip("'\"")  # 去除引号
        result[key] = val
    return result


def check_env_file(fix: bool) -> CheckResult:
    """检查 .env 是否存在、API Key 是否已配置。"""
    # 1) .env 文件是否存在
    if not ENV_FILE.exists():
        if not fix:
            return CheckResult(False, f".env 不存在，请复制 .env.example 并填写: cp .env.example .env")
        if ENV_EXAMPLE.exists():
            info("从 .env.example 创建 .env ...")
            import shutil as _sh
            _sh.copy2(ENV_EXAMPLE, ENV_FILE)
            return CheckResult(False, ".env 已从模板创建，请编辑 .env 填写至少一个 API Key 后重试", fixed=True)
        return CheckResult(False, ".env 不存在，且未找到 .env.example 模板")

    # 2) 解析 .env
    env_vars = _parse_env_file(ENV_FILE)
    problems: list[str] = []
    warnings: list[str] = []

    # 3) 检查是否至少配置了一个 API Key
    configured_keys = [k for k in _ALL_API_KEYS if env_vars.get(k)]
    if not configured_keys:
        problems.append("未配置任何 LLM API Key，至少需要一个才能调用大模型")

    # 4) 检查 DEFAULT_MODEL 与 API Key 的匹配
    default_model = env_vars.get("DEFAULT_MODEL", "")
    if default_model and configured_keys:
        # 简单匹配：模型 provider 前缀 → 对应的 API Key
        _MODEL_KEY_MAP = {
            "anthropic":  "ANTHROPIC_API_KEY",
            "openai":     "OPENAI_API_KEY",
            "deepseek":   "DEEPSEEK_API_KEY",
            "openrouter": "OPENROUTER_API_KEY",
            "dashscope":  "DASHSCOPE_API_KEY",
            "aihubmix":   "AIHUBMIX_API_KEY",
            "moonshot":   "MOONSHOT_API_KEY",
            "kimi":       "KIMI_API_KEY",
            "zhipu":      "ZHIPU_API_KEY",
            "vllm":       "HOSTED_VLLM_API_KEY",
        }
        provider = default_model.split("/")[0].lower() if "/" in default_model else ""
        if provider and provider in _MODEL_KEY_MAP:
            required_key = _MODEL_KEY_MAP[provider]
            if not env_vars.get(required_key):
                problems.append(f"DEFAULT_MODEL={default_model}，但 {required_key} 未配置")

    # 5) JWT_SECRET 安全警告
    jwt = env_vars.get("JWT_SECRET", "")
    if jwt and jwt in ("change-me-in-production", "your-secure-random-string"):
        warnings.append("JWT_SECRET 使用默认值，生产部署前请修改")

    # 输出警告
    for w in warnings:
        warn(w)

    if problems:
        return CheckResult(False, "; ".join(problems))

    key_names = ", ".join(k.replace("_API_KEY", "") for k in configured_keys)
    detail = f"已配置 API Key: {key_names}"
    if default_model:
        detail += f" | 默认模型: {default_model}"
    return CheckResult(True, detail)


# ── 主流程 ────────────────────────────────────────────────────────────

DOCKER_IMAGES = [
    "postgres:16-alpine",
]


def main():
    parser = argparse.ArgumentParser(description="AgentClaw 环境准备脚本")
    parser.add_argument("--check", action="store_true", help="仅检查，不自动修复")
    args = parser.parse_args()
    fix = not args.check

    platform_label = "Windows" if IS_WINDOWS else ("macOS" if sys.platform == "darwin" else "Linux")
    print(f"\n{BOLD(f'🔧 AgentClaw 环境准备 ({platform_label})')}")
    if args.check:
        print(f"  {DIM('模式：仅检查（--check）')}")
    else:
        print(f"  {DIM('模式：检查并自动修复')}")

    results: dict[str, CheckResult] = {}

    # 1. Docker 运行状态
    step("1. Docker 守护进程")
    r = check_docker_running()
    results["Docker 守护进程"] = r
    docker_ok = r.passed
    if r.passed:
        ok("Docker 正在运行")
    else:
        fail(r.detail)

    # 2. Docker 镜像
    step("2. Docker 镜像")
    for image in DOCKER_IMAGES:
        key = f"Docker 镜像 ({image})"
        if not docker_ok:
            results[key] = CheckResult(False, "跳过（Docker 未运行）")
            warn(f"{image} — 跳过（Docker 未运行）")
            continue
        r = check_docker_image(image, fix=fix)
        results[key] = r
        if r.passed:
            ok(f"{image}" + (" (已拉取)" if r.fixed else " (已存在)"))
        else:
            fail(f"{image}: {r.detail}")

    # 3. .env 环境变量
    step("3. .env 环境变量配置")
    r = check_env_file(fix=fix)
    results[".env 配置"] = r
    if r.passed:
        ok(r.detail)
    elif r.fixed:
        warn(r.detail)
    else:
        fail(r.detail)

    # ── 汇总 ──────────────────────────────────────────────────────────
    passed  = [k for k, v in results.items() if v.passed]
    failed  = [k for k, v in results.items() if not v.passed]
    fixed   = [k for k, v in results.items() if v.fixed]

    print(f"\n{'=' * 56}")
    print(BOLD("  准备结果汇总"))
    print(f"{'=' * 56}")
    print(f"  {GREEN('通过')}: {len(passed)} / {len(results)}")
    if fixed:
        print(f"  {CYAN('自动修复')}: {len(fixed)} 项")
        for k in fixed:
            print(f"    {CYAN('→')} {k}")
    if failed:
        print(f"  {RED('失败')}: {len(failed)} 项")
        for k in failed:
            detail = results[k].detail
            print(f"    {RED('✗')} {k}" + (f": {detail}" if detail else ""))
    print(f"{'=' * 56}\n")

    if not failed:
        print(GREEN("✓ 环境已就绪，可以运行 docker compose up -d"))
    else:
        print(RED("✗ 存在未解决的问题，请根据上方提示手动处理后重试"))
        sys.exit(1)


if __name__ == "__main__":
    main()
