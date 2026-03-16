import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, writeOpenclawConfig, type BridgeConfig } from "./config.js";
import { BridgeGatewayClient } from "./gateway-client.js";
import { createServer } from "./server.js";

async function waitForGateway(url: string, maxWaitMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const client = new BridgeGatewayClient(url);
      await Promise.race([
        client.start(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
      client.stop();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Gateway did not become ready within ${maxWaitMs}ms`);
}

function resolveGatewayCommand(): { cmd: string; args: string[]; cwd?: string } {
  const openclawDir = process.env.OPENCLAW_DIR;

  // 1. Explicit OPENCLAW_DIR (local dev or custom path)
  if (openclawDir) {
    const openclawMjs = path.join(openclawDir, "openclaw.mjs");
    if (fs.existsSync(openclawMjs)) {
      console.log(`[bridge] Using OPENCLAW_DIR: ${openclawDir}`);
      return { cmd: process.execPath, args: [openclawMjs], cwd: openclawDir };
    }
    // Dev mode: scripts/run-node.mjs
    const runNode = path.join(openclawDir, "scripts", "run-node.mjs");
    if (fs.existsSync(runNode)) {
      console.log("[bridge] Dev mode: using run-node.mjs (will auto-build if needed)");
      return { cmd: process.execPath, args: [runNode], cwd: openclawDir };
    }
  }

  // 2. Globally npm-installed openclaw command
  try {
    execSync("which openclaw", { stdio: "ignore" });
    console.log("[bridge] Using globally installed openclaw");
    return { cmd: "openclaw", args: [] };
  } catch { /* not in PATH */ }

  // 3. Fallback: openclaw.mjs in cwd (legacy mode)
  const cwdMjs = path.join(process.cwd(), "openclaw.mjs");
  if (fs.existsSync(cwdMjs)) {
    console.log("[bridge] Fallback: using openclaw.mjs in cwd");
    return { cmd: process.execPath, args: [cwdMjs] };
  }

  throw new Error(
    "Cannot find openclaw. Set OPENCLAW_DIR, install openclaw globally (npm i -g openclaw), " +
    "or ensure openclaw.mjs exists in the working directory."
  );
}

// Auto-review loop for skill-reviewer agent
function startAutoReviewLoop(config: BridgeConfig): void {
  const bridgeBase = `http://127.0.0.1:${config.bridgePort}`;

  async function pollAndReview() {
    try {
      // Poll for pending task
      const resp = await fetch(`${bridgeBase}/api/reviews/pending`);
      if (!resp.ok) {
        console.error("[auto-review] Failed to poll:", resp.status);
        return;
      }

      const data = await resp.json();
      if (!data.task) {
        // No pending tasks
        return;
      }

      const { id: taskId, skill_content: skillContent, file_path: filePath } = data.task;
      console.log(`[auto-review] Got task ${taskId}, reviewing...`);

      // Perform AI review
      const reviewResult = await performAIReview(skillContent, filePath);

      // Submit result
      const submitResp = await fetch(`${bridgeBase}/api/reviews/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id: taskId,
          review_result: JSON.stringify(reviewResult),
        }),
      });

      if (submitResp.ok) {
        console.log(`[auto-review] Task ${taskId} completed, score: ${reviewResult.score}`);
      } else {
        console.error("[auto-review] Failed to submit result:", submitResp.status);
      }
    } catch (err) {
      console.error("[auto-review] Error:", err);
    }
  }

  // Run every 30 seconds
  setInterval(pollAndReview, 30_000);
  console.log("[auto-review] Auto-review loop started (interval: 30s)");
}

// Simple AI review function (placeholder - actual implementation would use LLM)
async function performAIReview(skillContent: string, filePath?: string): Promise<{
  approved: boolean;
  score: number;
  issues: Array<{ severity: string; category: string; message: string; suggestion: string }>;
  summary: string;
}> {
  // Check for basic requirements
  const issues: Array<{ severity: string; category: string; message: string; suggestion: string }> = [];

  // Check for SKILL.md frontmatter
  if (!skillContent.includes("---")) {
    issues.push({
      severity: "critical",
      category: "format",
      message: "Missing frontmatter delimiter",
      suggestion: "Add --- at the start and end of frontmatter",
    });
  }

  // Check for name field
  const nameMatch = skillContent.match(/name:\s*(\S+)/);
  if (!nameMatch) {
    issues.push({
      severity: "critical",
      category: "format",
      message: "Missing 'name' field in frontmatter",
      suggestion: "Add name: your-skill-name to frontmatter",
    });
  }

  // Check for description field
  const descMatch = skillContent.match(/description:\s*"?([^"\n]+)/);
  if (!descMatch) {
    issues.push({
      severity: "major",
      category: "format",
      message: "Missing 'description' field in frontmatter",
      suggestion: "Add description: Brief description of what this skill does",
    });
  }

  // Check description length
  if (descMatch) {
    const desc = descMatch[1];
    if (desc.length < 20) {
      issues.push({
        severity: "minor",
        category: "description",
        message: "Description too short",
        suggestion: "Make description at least 20 characters to explain the skill clearly",
      });
    }
  }

  // Calculate score
  const criticalCount = issues.filter((i) => i.severity === "critical").length;
  const majorCount = issues.filter((i) => i.severity === "major").length;
  const minorCount = issues.filter((i) => i.severity === "minor").length;

  let score = 100;
  score -= criticalCount * 30;
  score -= majorCount * 15;
  score -= minorCount * 5;
  score = Math.max(0, score);

  const approved = criticalCount === 0 && score >= 60;

  return {
    approved,
    score,
    issues,
    summary: approved
      ? "Skill meets basic requirements."
      : `Found ${criticalCount} critical, ${majorCount} major, ${minorCount} minor issues.`,
  };
}

async function main(): Promise<void> {
  console.log("[bridge] Starting openclaw bridge...");

  const config = loadConfig();

  // Write openclaw config for platform proxy integration
  writeOpenclawConfig(config);
  console.log("[bridge] Wrote openclaw config");

  // Resolve how to launch the openclaw gateway
  const { cmd: gatewayCmd, args: gatewayBaseArgs, cwd: gatewayCwd } = resolveGatewayCommand();

  // Gateway always binds to loopback (no auth needed). External access goes
  // through the bridge WS relay on bridgePort instead.
  const gatewayArgs = [
    ...gatewayBaseArgs,
    "gateway", "run",
    "--port", String(config.gatewayPort),
    "--bind", "loopback",
    "--force",
  ];

  console.log(`[bridge] Starting openclaw gateway: ${gatewayCmd} ${gatewayArgs.join(" ")}`);
  const gatewayProc = spawn(gatewayCmd, gatewayArgs, {
    cwd: gatewayCwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(config.openclawHome, "openclaw.json"),
      OPENCLAW_STATE_DIR: config.openclawHome,
      OPENCLAW_SKIP_CHANNELS: "1",
    },
  });

  gatewayProc.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(`[gateway] ${data}`);
  });
  gatewayProc.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(`[gateway] ${data}`);
  });
  gatewayProc.on("exit", (code) => {
    console.error(`[bridge] Gateway process exited with code ${code}`);
    if (code !== 0) process.exit(1);
  });

  // Wait for gateway to be ready
  const gatewayUrl = `ws://127.0.0.1:${config.gatewayPort}`;
  console.log(`[bridge] Waiting for gateway at ${gatewayUrl}...`);
  await waitForGateway(gatewayUrl);
  console.log("[bridge] Gateway is ready");

  // Connect bridge client to gateway
  const client = new BridgeGatewayClient(gatewayUrl);
  await client.start();
  console.log("[bridge] Connected to gateway");

  // Configure skill review mode
  if (config.enableAutoReview) {
    console.log("[bridge] Auto-review mode: ENABLED");
    // Create skill-reviewer agent for admin if it doesn't exist
    try {
      const agentsResp = await client.request<{ agents: Array<{ id: string }> }>("agents.list", {});
      const agents = agentsResp.agents ?? [];
      const hasReviewer = agents.some((a) => a.id === "skill-reviewer");
      if (!hasReviewer) {
        console.log("[bridge] Creating skill-reviewer agent...");
        await client.request("agents.create", {
          name: "skill-reviewer",
          workspace: "~/.openclaw/workspace-skill-reviewer",
          emoji: "🔍",
        });
        console.log("[bridge] Created skill-reviewer agent");
      } else {
        console.log("[bridge] skill-reviewer agent already exists");
      }

      // Start auto-review loop
      startAutoReviewLoop(config);
    } catch (err) {
      console.error("[bridge] Failed to setup auto-review:", err);
    }
  } else {
    console.log("[bridge] Auto-review mode: DISABLED (manual review only)");
    console.log("[bridge] Set BRIDGE_ENABLE_AUTO_REVIEW=true to enable AI auto-review");
  }

  // Start bridge HTTP server
  const server = createServer(client, config);
  server.listen(config.bridgePort, "0.0.0.0", () => {
    console.log(`[bridge] Bridge server listening on port ${config.bridgePort}`);
  });

  // Auto-sync platform skills to database (if gateway is configured)
  if (config.proxyUrl) {
    setTimeout(async () => {
      try {
        const gatewayBase = config.proxyUrl!.replace("/llm/v1", "").replace(/\/+$/, "");
        const resp = await fetch(`${gatewayBase}/api/admin/skills/platform-skills/sync`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${config.proxyToken || ""}`,
          },
        });
        if (resp.ok) {
          const data = await resp.json() as { added: number };
          console.log(`[bridge] Platform skills synced: ${data.added} new skills added`);
        } else {
          console.log("[bridge] Platform skills sync: no new skills or already synced");
        }
      } catch (err) {
        console.log("[bridge] Platform skills sync skipped (gateway may not be ready)");
      }
    }, 5000); // Wait 5s for gateway to fully initialize
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log("[bridge] Shutting down...");
    client.stop();
    gatewayProc.kill("SIGTERM");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[bridge] Fatal error:", err);
  process.exit(1);
});
