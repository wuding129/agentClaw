"""LLM Proxy — the security core of the multi-tenant platform.

Receives OpenAI-compatible requests from user containers (authenticated
by container token), injects the real API key, records usage, enforces
quotas, and forwards to the actual LLM provider.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta

import litellm
from fastapi import HTTPException, status
from litellm import acompletion
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

# Drop unsupported params (e.g., gpt-5 doesn't support temperature=0.7)
litellm.drop_params = True

from app.auth.service import decode_token
from app.config import settings
from app.db.models import Container, UsageRecord, User

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Model → provider mapping
# ---------------------------------------------------------------------------

_MODEL_PROVIDER_MAP: dict[str, tuple[str, str]] = {
    # keyword in model name → (litellm prefix, settings attr for api key)
    "claude": ("", "anthropic_api_key"),
    "gpt": ("", "openai_api_key"),
    "deepseek": ("deepseek", "deepseek_api_key"),
    "o1": ("", "openai_api_key"),
    "o3": ("", "openai_api_key"),
    "o4": ("", "openai_api_key"),
    "moonshot": ("", "moonshot_api_key"),
    "glm": ("", "zhipu_api_key"),
}

# OpenAI-compatible providers that need a custom api_base
_CUSTOM_BASE_PROVIDERS: dict[str, tuple[str, str]] = {
    # keyword → (api_base, settings attr for api key)
    "qwen": ("https://dashscope.aliyuncs.com/compatible-mode/v1", "dashscope_api_key"),
    "kimi": ("https://api.moonshot.cn/v1", "kimi_api_key"),
    "aihubmix": ("https://aihubmix.com/v1", "aihubmix_api_key"),
}

# Models that only accept temperature=1 (or don't support temperature at all)
_FIXED_TEMPERATURE_MODELS = {"kimi-k2.5", "kimi-k2-thinking", "kimi-k2-thinking-turbo"}


def _sanitize_messages(messages: list[dict]) -> list[dict]:
    """Sanitize messages for broad LLM provider compatibility.

    OpenClaw's agent engine sends OpenAI-native messages that may contain
    extra fields (name, refusal, audio, etc.) or null content that some
    providers (e.g. StepFun via OpenRouter) reject as 'Unrecognized chat message'.
    """
    # Fields allowed per role
    _ALLOWED = {
        "system": {"role", "content", "name"},
        "user": {"role", "content", "name"},
        "assistant": {"role", "content", "tool_calls", "refusal"},
        "tool": {"role", "content", "tool_call_id"},
    }

    cleaned = []
    for msg in messages:
        role = msg.get("role", "user")
        allowed = _ALLOWED.get(role, {"role", "content"})

        out: dict = {}
        for k in allowed:
            if k in msg:
                out[k] = msg[k]

        # Ensure content is never None for non-assistant roles
        # (some providers reject null content)
        if role != "assistant" and out.get("content") is None:
            out["content"] = ""

        # For assistant role with tool_calls, content can be null per OpenAI spec
        # but some providers reject it — set to empty string
        if role == "assistant" and out.get("content") is None:
            out["content"] = ""

        # Strip 'name' field if provider might not support it
        # (we keep it for now — litellm usually handles it)

        # Normalize tool_calls: ensure each has required fields
        if "tool_calls" in out and out["tool_calls"]:
            sanitized_tc = []
            for tc in out["tool_calls"]:
                if isinstance(tc, dict) and "function" in tc:
                    sanitized_tc.append({
                        "id": tc.get("id", ""),
                        "type": tc.get("type", "function"),
                        "function": {
                            "name": tc["function"].get("name", ""),
                            "arguments": tc["function"].get("arguments", "{}"),
                        },
                    })
            out["tool_calls"] = sanitized_tc
            # If no valid tool_calls remain, remove the key
            if not out["tool_calls"]:
                del out["tool_calls"]

        cleaned.append(out)

    return cleaned


def _resolve_provider(model: str) -> tuple[str, str, str | None]:
    """Return (litellm_model_name, api_key, api_base_or_None) for the given model."""
    model_lower = model.lower()

    # Unified LLM endpoint: highest priority when configured
    # This allows using a single endpoint (e.g., OpenRouter, custom proxy) for all models
    if settings.llm_api_base and settings.llm_api_key:
        # Support provider prefix in model name, e.g.:
        # - "openrouter/stepfun/step-3.5-flash:free" -> use openrouter provider
        # - "together/meta-llama/Meta-Llama-3.1-70B" -> use together provider
        # - "stepfun/step-3.5-flash:free" -> use openai provider (generic OpenAI-compatible)
        if "/" in model:
            provider_prefix, actual_model = model.split("/", 1)
            # Known LiteLLM providers that need special handling
            if provider_prefix in ("openrouter", "together", "fireworks", "azure", "hosted_vllm", "ollama"):
                return f"{provider_prefix}/{actual_model}", settings.llm_api_key, settings.llm_api_base
        # Default: use openai provider prefix for generic OpenAI-compatible endpoints
        return f"openai/{model}", settings.llm_api_key, settings.llm_api_base

    # Self-hosted vLLM: when configured, use it for the default model.
    # This takes priority so that e.g. a VLLM-served "Qwen3-14B" isn't
    # accidentally routed to DashScope via the "qwen" keyword.
    if settings.hosted_vllm_api_base:
        vllm_key = settings.hosted_vllm_api_key or "dummy"
        return f"hosted_vllm/{model}", vllm_key, settings.hosted_vllm_api_base

    # Custom Claude endpoint (native Claude protocol)
    if "claude" in model_lower and settings.claude_api_base:
        api_key = settings.claude_api_key or settings.anthropic_api_key or ""
        if api_key:
            return model, api_key, settings.claude_api_base

    # Check custom-base providers first (DashScope, AiHubMix, etc.)
    for keyword, (api_base, key_attr) in _CUSTOM_BASE_PROVIDERS.items():
        if keyword in model_lower:
            api_key = getattr(settings, key_attr, "")
            if api_key:
                # Strip provider prefix (e.g. "dashscope/qwen3-coder-plus" → "qwen3-coder-plus")
                actual_model = model.split("/", 1)[1] if "/" in model else model
                return f"openai/{actual_model}", api_key, api_base

    # Check standard providers
    for keyword, (prefix, key_attr) in _MODEL_PROVIDER_MAP.items():
        if keyword in model_lower:
            api_key = getattr(settings, key_attr, "")
            if api_key:
                litellm_model = f"{prefix}/{model}" if prefix else model
                return litellm_model, api_key, None

    # Fallback: OpenRouter (routes any model)
    if settings.openrouter_api_key:
        return f"openrouter/{model}", settings.openrouter_api_key, None

    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"No provider configured for model '{model}'",
    )


# ---------------------------------------------------------------------------
# Quota check
# ---------------------------------------------------------------------------

_TIER_LIMITS = {
    "free": settings.quota_free,
    "basic": settings.quota_basic,
    "pro": settings.quota_pro,
}


async def _check_quota(db: AsyncSession, user: User) -> None:
    """Raise 429 if the user exceeded their daily quota."""
    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    result = await db.execute(
        select(func.coalesce(func.sum(UsageRecord.total_tokens), 0)).where(
            UsageRecord.user_id == user.id,
            UsageRecord.created_at >= today_start,
        )
    )
    used_today: int = result.scalar_one()
    limit = _TIER_LIMITS.get(user.quota_tier, _TIER_LIMITS["free"])

    if used_today >= limit:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Daily token quota exceeded ({used_today:,}/{limit:,}). Resets at midnight UTC.",
        )


# ---------------------------------------------------------------------------
# Core proxy handler
# ---------------------------------------------------------------------------

async def proxy_chat_completion(
    db: AsyncSession,
    container_token: str,
    model: str,
    messages: list[dict],
    max_tokens: int = 4096,
    temperature: float = 0.7,
    tools: list[dict] | None = None,
    stream: bool = False,
    agent_id: str | None = None,
):
    """Validate token, check quota, forward to real LLM, record usage.

    Args:
        agent_id: In multi-agent architecture, this is the user_id from X-Agent-Id header.
                  When provided with empty container_token, use this to identify the user.
    """

    # Shared platform token for multi-agent architecture
    PLATFORM_SHARED_TOKEN = "platform-shared-token"

    # 1. Authenticate — supports container token or JWT API token
    # In local dev mode (dev_openclaw_url set), skip validation and quota check.
    if settings.dev_openclaw_url:
        container = None
        user = None
    else:
        container = None
        user = None

        # Multi-agent mode: use agent_id (which is user_id) to identify user
        # This works for both shared platform token and individual container tokens
        if agent_id:
            user_result = await db.execute(select(User).where(User.id == agent_id))
            user = user_result.scalar_one_or_none()
            if user is None:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid agent_id")
        elif container_token == PLATFORM_SHARED_TOKEN:
            # Shared token without agent_id is invalid
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing X-Agent-Id header for shared token authentication"
            )
        else:
            # Try JWT API token first
            jwt_payload = decode_token(container_token)
            if jwt_payload and jwt_payload.get("type") == "access":
                user_id = jwt_payload.get("sub")
                if user_id:
                    user_result = await db.execute(select(User).where(User.id == user_id))
                    user = user_result.scalar_one_or_none()

            # Fallback: container token (now per-agent instead of per-user)
            if user is None:
                result = await db.execute(
                    select(Container).where(Container.container_token == container_token)
                )
                container = result.scalar_one_or_none()
                if container is None:
                    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
                # Check token expiration
                if container.is_token_expired():
                    raise HTTPException(
                        status_code=status.HTTP_401_UNAUTHORIZED,
                        detail="Container token has expired, please re-authenticate"
                    )
                # Find user through UserAgent (agent_id -> UserAgent -> user_id)
                from app.db.models import UserAgent
                agent_result = await db.execute(
                    select(UserAgent).where(UserAgent.openclaw_agent_id == container.agent_id)
                )
                user_agent = agent_result.scalar_one_or_none()
                if user_agent:
                    user_result = await db.execute(select(User).where(User.id == user_agent.user_id))
                    user = user_result.scalar_one_or_none()

        if user is None or not user.is_active:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User account disabled")

        await _check_quota(db, user)

    # 3. Resolve provider
    litellm_model, api_key, api_base = _resolve_provider(model)

    # 3b. Sanitize messages for provider compatibility
    messages = _sanitize_messages(messages)

    # Debug: log message roles to help diagnose tool-call failures
    msg_summary = [(m.get("role"), "tool_calls" in m, m.get("tool_call_id") is not None) for m in messages]
    logger.info(f"LLM proxy: model={model}, messages={len(messages)}, roles={msg_summary}")

    # 4. Call LLM
    kwargs: dict = {
        "model": litellm_model,
        "messages": messages,
        "max_tokens": max_tokens,
        "api_key": api_key,
        "stream": stream,
    }
    # Some models (e.g. kimi-k2.5) only accept temperature=1; skip the param for them.
    model_base = model.split("/")[-1].lower()
    if model_base not in _FIXED_TEMPERATURE_MODELS:
        kwargs["temperature"] = temperature
    if api_base:
        kwargs["api_base"] = api_base
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = "auto"

    # OpenRouter requires extra headers for identification
    if api_base and "openrouter" in api_base.lower():
        kwargs["extra_headers"] = {
            "HTTP-Referer": "https://openclaw.local",
            "X-Title": "OpenClaw MultiUser",
        }

    try:
        response = await acompletion(**kwargs)
    except Exception as e:
        logger.error(f"LLM proxy error for model={model}: {e}")
        logger.error(f"LLM proxy kwargs (no messages): { {k: v for k, v in kwargs.items() if k != 'messages'} }")
        # Dump first few messages for debugging (truncate content)
        for i, m in enumerate(messages[:5]):
            dbg = {k: (v[:200] if isinstance(v, str) else v) for k, v in m.items()}
            logger.error(f"  msg[{i}]: {dbg}")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"LLM provider error: {e}",
        )

    # 4b. Streaming: return an async generator that yields SSE chunks
    if stream:
        import json

        async def _stream_generator():
            try:
                async for chunk in response:
                    data = chunk.model_dump()
                    yield f"data: {json.dumps(data)}\n\n"
                yield "data: [DONE]\n\n"
            except Exception:
                yield "data: [DONE]\n\n"

        return _stream_generator()

    # 5. Record usage (skip in dev mode)
    if user is not None:
        usage = getattr(response, "usage", None)
        if usage:
            record = UsageRecord(
                user_id=user.id,
                model=model,
                input_tokens=usage.prompt_tokens or 0,
                output_tokens=usage.completion_tokens or 0,
                total_tokens=usage.total_tokens or 0,
            )
            db.add(record)
            await db.commit()

    # 6. Update container last_active_at (skip in dev mode)
    if container is not None:
        container.last_active_at = datetime.utcnow()
        await db.commit()

    # 7. Return OpenAI-compatible response
    return response.model_dump()
