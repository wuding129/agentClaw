import { Router } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, exec } from "node:child_process";
import type { BridgeConfig } from "../config.js";
import { asyncHandler } from "../utils.js";

// Strip ANSI escape codes
function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");
}

interface SkillSearchResult {
  slug: string;
  url: string;
  installs: string;
}

function parseSkillsFindOutput(raw: string): SkillSearchResult[] {
  const clean = stripAnsi(raw);
  const results: SkillSearchResult[] = [];
  const lines = clean.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    // Match lines like: owner/repo@skill-name  123 installs
    const match = line.match(/^(\S+\/\S+@\S+)\s+(.+?\s+installs?)$/);
    if (match) {
      const slug = match[1]!;
      const installs = match[2]!.trim();
      // Next line is the URL
      const urlLine = lines[i + 1]?.trim();
      const url = urlLine?.startsWith("└") ? urlLine.replace(/^└\s*/, "") : `https://skills.sh/${slug.replace("@", "/")}`;
      results.push({ slug, url, installs });
    }
  }
  return results;
}

interface MarketplaceEntry {
  name: string;
  source: string;
  type: "git" | "local";
}

interface MarketplacePluginInfo {
  name: string;
  description: string;
  marketplace_name: string;
  installed: boolean;
}

function getMarketplacesDir(): string {
  return path.join(os.homedir(), ".frameclaw", "marketplaces");
}

function getMarketplacesRegistry(): string {
  return path.join(getMarketplacesDir(), "registry.json");
}

function loadRegistry(): MarketplaceEntry[] {
  const registryPath = getMarketplacesRegistry();
  if (!fs.existsSync(registryPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(registryPath, "utf-8"));
  } catch {
    return [];
  }
}

function saveRegistry(entries: MarketplaceEntry[]): void {
  const dir = getMarketplacesDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getMarketplacesRegistry(), JSON.stringify(entries, null, 2));
}

function isGitUrl(source: string): boolean {
  return (
    source.startsWith("https://") ||
    source.startsWith("ssh://") ||
    source.startsWith("git://") ||
    source.startsWith("git@") ||
    source.endsWith(".git")
  );
}

function nameFromSource(source: string): string {
  const base = path.basename(source, ".git");
  return base || "marketplace";
}

function getCachePath(name: string): string {
  return path.join(getMarketplacesDir(), "cache", name);
}

export function marketplacesRoutes(config: BridgeConfig): Router {
  const router = Router();

  // GET /api/marketplaces
  router.get("/marketplaces", asyncHandler(async (_req, res) => {
    res.json(loadRegistry());
  }));

  // POST /api/marketplaces
  router.post("/marketplaces", asyncHandler(async (req, res) => {
    const { source } = req.body;
    if (!source) {
      res.status(400).json({ detail: "Source is required" });
      return;
    }

    const type = isGitUrl(source) ? "git" : "local";
    const name = nameFromSource(source);

    const registry = loadRegistry();
    if (registry.some((m) => m.name === name)) {
      res.status(400).json({ detail: `Marketplace '${name}' already exists` });
      return;
    }

    const entry: MarketplaceEntry = { name, source, type };

    // Clone if git
    if (type === "git") {
      const cachePath = getCachePath(name);
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      try {
        execSync(`git clone --depth 1 "${source}" "${cachePath}"`, { stdio: "pipe" });
      } catch (err) {
        res.status(400).json({ detail: `Failed to clone: ${(err as Error).message}` });
        return;
      }
    } else {
      // Validate local path exists
      if (!fs.existsSync(source)) {
        res.status(400).json({ detail: `Local path does not exist: ${source}` });
        return;
      }
    }

    registry.push(entry);
    saveRegistry(registry);
    res.json(entry);
  }));

  // DELETE /api/marketplaces/:name
  router.delete("/marketplaces/:name", asyncHandler(async (req, res) => {
    const name = req.params.name;
    const registry = loadRegistry();
    const idx = registry.findIndex((m) => m.name === name);

    if (idx === -1) {
      res.status(404).json({ detail: "Marketplace not found" });
      return;
    }

    registry.splice(idx, 1);
    saveRegistry(registry);

    // Clean up cache
    const cachePath = getCachePath(name);
    if (fs.existsSync(cachePath)) {
      fs.rmSync(cachePath, { recursive: true });
    }

    res.json({ ok: true });
  }));

  // POST /api/marketplaces/:name/update
  router.post("/marketplaces/:name/update", asyncHandler(async (req, res) => {
    const name = req.params.name;
    const registry = loadRegistry();
    const entry = registry.find((m) => m.name === name);

    if (!entry) {
      res.status(404).json({ detail: "Marketplace not found" });
      return;
    }

    if (entry.type === "git") {
      const cachePath = getCachePath(name);
      if (fs.existsSync(cachePath)) {
        try {
          execSync("git pull --rebase", { cwd: cachePath, stdio: "pipe" });
        } catch {
          // Re-clone on pull failure
          fs.rmSync(cachePath, { recursive: true });
          execSync(`git clone --depth 1 "${entry.source}" "${cachePath}"`, { stdio: "pipe" });
        }
      } else {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        execSync(`git clone --depth 1 "${entry.source}" "${cachePath}"`, { stdio: "pipe" });
      }
    } else {
      if (!fs.existsSync(entry.source)) {
        res.status(400).json({ detail: "Local path no longer exists" });
        return;
      }
    }

    res.json(entry);
  }));

  // GET /api/marketplaces/:name/plugins
  router.get("/marketplaces/:name/plugins", asyncHandler(async (req, res) => {
    const name = req.params.name;
    const registry = loadRegistry();
    const entry = registry.find((m) => m.name === name);

    if (!entry) {
      res.status(404).json({ detail: "Marketplace not found" });
      return;
    }

    const sourcePath = entry.type === "git" ? getCachePath(name) : entry.source;
    if (!fs.existsSync(sourcePath)) {
      res.status(400).json({ detail: "Marketplace source not available" });
      return;
    }

    const plugins: MarketplacePluginInfo[] = [];
    const installedPluginsDir = path.join(os.homedir(), ".frameclaw", "plugins");

    for (const dirEntry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
      if (!dirEntry.isDirectory() || dirEntry.name.startsWith(".")) continue;

      const pluginDir = path.join(sourcePath, dirEntry.name);
      // Check if it looks like a plugin (has plugin.json or agents/ or skills/)
      const hasPluginJson = fs.existsSync(path.join(pluginDir, "plugin.json"));
      const hasAgents = fs.existsSync(path.join(pluginDir, "agents"));
      const hasSkills = fs.existsSync(path.join(pluginDir, "skills"));

      if (!hasPluginJson && !hasAgents && !hasSkills) continue;

      let description = "";
      if (hasPluginJson) {
        try {
          const pj = JSON.parse(fs.readFileSync(path.join(pluginDir, "plugin.json"), "utf-8"));
          description = pj.description || "";
        } catch { /* ignore */ }
      }

      const installed = fs.existsSync(path.join(installedPluginsDir, dirEntry.name));

      plugins.push({
        name: dirEntry.name,
        description,
        marketplace_name: name,
        installed,
      });
    }

    res.json(plugins);
  }));

  // POST /api/marketplaces/:name/plugins/:plugin_name/install
  router.post("/marketplaces/:name/plugins/:plugin_name/install", asyncHandler(async (req, res) => {
    const { name, plugin_name } = req.params;
    const registry = loadRegistry();
    const entry = registry.find((m) => m.name === name);

    if (!entry) {
      res.status(400).json({ detail: "Marketplace not found" });
      return;
    }

    const sourcePath = entry.type === "git" ? getCachePath(name) : entry.source;
    const pluginSourceDir = path.join(sourcePath, plugin_name);

    if (!fs.existsSync(pluginSourceDir)) {
      res.status(400).json({ detail: "Plugin not found in marketplace" });
      return;
    }

    const installedPluginsDir = path.join(os.homedir(), ".frameclaw", "plugins");
    const destDir = path.join(installedPluginsDir, plugin_name);

    fs.mkdirSync(installedPluginsDir, { recursive: true });
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true });
    }
    fs.cpSync(pluginSourceDir, destDir, { recursive: true });

    res.json({ ok: true, path: destDir });
  }));

  // -----------------------------------------------------------------------
  // Skills CLI integration (skills.sh)
  // -----------------------------------------------------------------------

  // POST /api/marketplaces/skills/search — search skills via `npx skills find`
  router.post("/marketplaces/skills/search", asyncHandler(async (req, res) => {
    const { query, limit } = req.body;
    if (!query || typeof query !== "string") {
      res.status(400).json({ detail: "query is required" });
      return;
    }
    const safeQuery = query.replace(/[^\w\s\-]/g, "").slice(0, 100);
    const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 30);

    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        exec(
          `npx --yes skills find ${JSON.stringify(safeQuery)} --limit ${safeLimit}`,
          { timeout: 30000, env: { ...process.env, NO_COLOR: "1" } },
          (err, stdout, stderr) => {
            // skills find exits 0 on success; parse stdout regardless
            if (stdout) resolve(stdout);
            else reject(new Error(stderr || (err?.message ?? "skills find failed")));
          },
        );
      });
      const results = parseSkillsFindOutput(stdout);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // POST /api/marketplaces/skills/install — install a skill via `npx skills add`
  router.post("/marketplaces/skills/install", asyncHandler(async (req, res) => {
    const { slug } = req.body;
    if (!slug || typeof slug !== "string") {
      res.status(400).json({ detail: "slug is required" });
      return;
    }
    // Validate slug format: owner/repo@skill or owner/repo
    if (!/^[\w\-.]+\/[\w\-.]+(@[\w\-.]+)?$/.test(slug)) {
      res.status(400).json({ detail: "invalid slug format" });
      return;
    }

    // Resolve per-user workspace for multi-tenant isolation
    const headerAgentId = req.headers["x-agent-id"] as string | undefined;
    const headerSig = req.headers["x-agent-id-sig"] as string | undefined;
    let agentId = "main";
    if (headerAgentId && /^[a-z0-9][a-z0-9_-]*$/.test(headerAgentId)) {
      if (headerAgentId === "main") {
        agentId = "main";
      } else {
        const expected = crypto
          .createHmac("sha256", config.bridgeToken)
          .update(`${headerAgentId}:${config.bridgeToken}`)
          .digest("hex")
          .slice(0, 16);
        if (headerSig === expected) {
          agentId = headerAgentId;
        }
      }
    }
    const workspacePath = agentId === "main"
      ? config.workspacePath
      : path.join(config.openclawHome, `workspace-${agentId}`);
    fs.mkdirSync(workspacePath, { recursive: true });

    // skills add -g always installs to $HOME/.openclaw/skills/ regardless of OPENCLAW_HOME.
    // After install, move the skill(s) into the user's workspace/skills/ directory.
    const homeSkillsDir = path.join(os.homedir(), ".openclaw", "skills");
    const destSkillsDir = path.join(workspacePath, "skills");

    // Snapshot what's already in $HOME/.openclaw/skills before install
    const before = new Set(fs.existsSync(homeSkillsDir) ? fs.readdirSync(homeSkillsDir) : []);

    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        exec(
          `npx --yes skills add ${slug} -g -y --copy`,
          { timeout: 180000, env: { ...process.env, NO_COLOR: "1" } },
          (err, stdout, stderr) => {
            const cleanStderr = stripAnsi(stderr || "")
              .split("\n")
              .filter((l) => !l.startsWith("npm warn") && l.trim())
              .join("\n")
              .trim();
            if (err && cleanStderr) reject(new Error(cleanStderr));
            else resolve(stripAnsi(stdout || ""));
          },
        );
      });

      // Move newly installed skill(s) from $HOME/.openclaw/skills/ to user workspace
      fs.mkdirSync(destSkillsDir, { recursive: true });
      if (fs.existsSync(homeSkillsDir)) {
        for (const entry of fs.readdirSync(homeSkillsDir)) {
          if (before.has(entry)) continue; // skip pre-existing
          const src = path.join(homeSkillsDir, entry);
          const dest = path.join(destSkillsDir, entry);
          if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
          fs.renameSync(src, dest);
        }
      }

      res.json({ ok: true, output: stdout.trim() });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  return router;
}
