import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface BridgeConfig {
  proxyUrl: string;
  proxyToken: string;
  bridgeToken: string; // Token for verifying isAdmin signature from Platform Gateway
  model: string;
  gatewayPort: number;
  bridgePort: number;
  openclawHome: string;
  workspacePath: string;
  uploadsPath: string;
  sessionsPath: string;
  enableAutoReview: boolean; // 是否启用自动审核agent
}

export function loadConfig(): BridgeConfig {
  const proxyUrl = process.env.FRAMECLAW_PROXY__URL || "http://localhost:8080/llm/v1";
  const proxyToken = process.env.FRAMECLAW_PROXY__TOKEN || "dev-token";
  const bridgeToken = process.env.PLATFORM_BRIDGE_TOKEN || "change-me-in-production";
  const model = process.env.FRAMECLAW_AGENTS__DEFAULTS__MODEL || "claude-sonnet-4-20250514";
  const gatewayPort = parseInt(process.env.OPENCLAW_GATEWAY_PORT || "18789", 10);
  const bridgePort = parseInt(process.env.BRIDGE_PORT || "18080", 10);
  const openclawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
  const workspacePath = process.env.OPENCLAW_WORKSPACE || path.join(openclawHome, "workspace");
  const uploadsPath = path.join(openclawHome, "uploads");
  const sessionsPath = path.join(openclawHome, "sessions");
  // 默认不启用自动审核，需要管理员显式开启
  const enableAutoReview = process.env.BRIDGE_ENABLE_AUTO_REVIEW === "true";

  return {
    proxyUrl,
    proxyToken,
    bridgeToken,
    model,
    gatewayPort,
    bridgePort,
    openclawHome,
    workspacePath,
    uploadsPath,
    sessionsPath,
    enableAutoReview,
  };
}

/**
 * Write openclaw config file so the gateway uses our platform LLM proxy.
 */
export function writeOpenclawConfig(cfg: BridgeConfig): void {
  const configDir = cfg.openclawHome;
  fs.mkdirSync(configDir, { recursive: true });

  const openclawConfig = {
    models: {
      mode: "replace",
      providers: {
        "platform-proxy": {
          baseUrl: cfg.proxyUrl,
          api: "openai-completions",
          apiKey: cfg.proxyToken,
          models: [{
            id: cfg.model,
            name: cfg.model,
          }],
        },
      },
    },
    tools: {
      profile: "full",
      elevated: { enabled: false },  // 禁止沙盒逃逸到主机
      web: {
        fetch: { enabled: true },
        search: { enabled: true },
      },
    },
    agents: {
      defaults: {
        model: `platform-proxy/${cfg.model}`,
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "rw",
          docker: {
            // 镜像配置 - 使用预装工具的镜像
            image: "openclaw-sandbox:agentclaw",
            // 网络和权限 - skill agent 需要网络访问和安装工具
            readOnlyRoot: false,
            network: "bridge",
            user: "0:0",  // root 权限用于安装包
            // 资源限制 - 防止滥用
            pidsLimit: 256,
            memory: "2g",
            cpus: 2,
            // 安全加固
            capDrop: ["ALL"],
            tmpfs: ["/tmp", "/var/tmp"],
          },
          // 自动清理空闲沙盒
          prune: {
            idleHours: 2,
            maxAgeDays: 7,
          },
        },
      },
    },
    gateway: {
      mode: "local",
      port: cfg.gatewayPort,
      bind: "loopback",
      auth: { mode: "none" },
      controlUi: {
        allowedOrigins: [
          "http://localhost:3080",
          "http://127.0.0.1:3080",
          "http://localhost:8080",
          "http://127.0.0.1:8080",
          `http://localhost:${cfg.gatewayPort}`,
          `http://127.0.0.1:${cfg.gatewayPort}`,
        ],
      },
    },
  };

  const configPath = path.join(configDir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify(openclawConfig, null, 2), "utf-8");

  // Ensure workspace, uploads, sessions directories exist
  fs.mkdirSync(cfg.workspacePath, { recursive: true });
  fs.mkdirSync(cfg.uploadsPath, { recursive: true });
  fs.mkdirSync(cfg.sessionsPath, { recursive: true });
}
