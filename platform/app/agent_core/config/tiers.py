"""Tier configuration system — drives routing and resource allocation."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass
class SandboxConfig:
    """Sandbox configuration for shared-backend tiers."""

    mode: str = "docker"
    scope: str = "agent"
    memory: str = "2g"
    cpus: int = 2
    prune_idle_hours: int = 2


@dataclass
class ContainerConfig:
    """Container configuration for dedicated-backend tiers."""

    image: str = "openclaw:latest"
    memory: str = "4g"
    cpus: int = 2
    pids_limit: int = 512
    auto_stop_hours: int = 24
    auto_destroy_days: int = 90


@dataclass
class TierConfig:
    """
    Complete configuration for a single tier.
    Controls backend routing, resource limits, features, and quotas.
    """

    name: str
    backend: str  # "shared" | "dedicated"
    max_agents: int | None = None  # None = unlimited
    max_sessions_per_agent: int | None = None  # None = unlimited
    sandbox: SandboxConfig | None = None
    container: ContainerConfig | None = None
    features: dict[str, bool] | None = None
    quota: dict[str, int | None] | None = None


class TierConfigManager:
    """
    Manages tier configurations loaded from tiers.yaml.

    Usage:
        manager = TierConfigManager()
        tier = manager.get_tier("free")
        if tier.backend == "shared":
            ...
    """

    def __init__(self, config_path: Path | None = None) -> None:
        if config_path is None:
            config_path = Path(__file__).parent / "tiers.yaml"
        self._config_path = config_path
        self._tiers: dict[str, TierConfig] = {}
        self._load()

    def _load(self) -> None:
        """Load tiers from YAML configuration file."""
        with open(self._config_path, encoding="utf-8") as f:
            raw = yaml.safe_load(f)

        for name, cfg in raw.get("tiers", {}).items():
            sandbox_cfg = None
            if cfg.get("sandbox"):
                sandbox_cfg = SandboxConfig(**cfg["sandbox"])

            container_cfg = None
            if cfg.get("container"):
                container_cfg = ContainerConfig(**cfg["container"])

            self._tiers[name] = TierConfig(
                name=name,
                backend=cfg.get("backend", "shared"),
                max_agents=cfg.get("max_agents"),
                max_sessions_per_agent=cfg.get("max_sessions_per_agent"),
                sandbox=sandbox_cfg,
                container=container_cfg,
                features=cfg.get("features"),
                quota=cfg.get("quota"),
            )

    def get_tier(self, tier_name: str) -> TierConfig:
        """Get tier config by name, fallback to 'free' if unknown."""
        return self._tiers.get(tier_name, self._tiers.get("free"))

    def get_all_tiers(self) -> dict[str, TierConfig]:
        """Return a copy of all tier configs."""
        return self._tiers.copy()

    def is_feature_enabled(self, tier_name: str, feature: str) -> bool:
        """Check if a feature is enabled for a tier."""
        tier = self.get_tier(tier_name)
        if tier.features is None:
            return False
        return tier.features.get(feature, False)

    def reload(self) -> None:
        """Reload configuration from disk."""
        self._load()
