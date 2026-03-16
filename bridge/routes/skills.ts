import express, { Router, type Request } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import archiver from "archiver";
import unzipper from "unzipper";
import type { BridgeConfig } from "../config.js";
import type { BridgeGatewayClient } from "../gateway-client.js";
import { asyncHandler } from "../utils.js";

interface SkillInfo {
  name: string;
  description: string;
  source: string;
  available: boolean;
  disabled: boolean;
  compatible: boolean;
  path: string;
}

function parseSkillMd(content: string): { description: string; requiredBins: string[]; platforms: string[] } {
  // Extract description from SKILL.md frontmatter or first line
  const lines = content.split("\n");
  let inFrontmatter = false;
  let description = "";
  const requiredBins: string[] = [];
  const platforms: string[] = [];

  for (const line of lines) {
    if (line.trim() === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) {
      const match = line.match(/^description:\s*(.+)/);
      if (match) {
        description = match[1].trim();
      }
    }
  }

  if (!description && lines.length > 0) {
    // Use first non-empty, non-frontmatter line as description
    description = lines.find((l) => l.trim() && l.trim() !== "---") || "";
  }

  // Detect platform-specific skills
  if (/\b(macos|mac app|darwin|osascript|apple-?script)\b/i.test(content)) platforms.push("macos");
  if (/\b(ios|iphone|ipad)\b/i.test(content)) platforms.push("ios");

  // Extract required bins from metadata
  const binsMatch = content.match(/"requires"\s*:\s*\{\s*"bins"\s*:\s*\[([^\]]+)\]/);
  if (binsMatch) {
    const binList = binsMatch[1].match(/"([^"]+)"/g);
    if (binList) {
      requiredBins.push(...binList.map(b => b.replace(/"/g, "")));
    }
  }

  return { description, requiredBins, platforms };
}

import { execFileSync, execSync } from "node:child_process";

function isBinAvailable(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function scanSkillsDir(dir: string, source: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  if (!fs.existsSync(dir)) return skills;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Follow symlinks: isDirectory() returns false for symlinks
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const entryPath = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(entryPath);
      if (!stat.isDirectory()) continue;
    } catch { continue; }
    const skillMdPath = path.join(entryPath, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    const content = fs.readFileSync(skillMdPath, "utf-8");
    const { description, requiredBins, platforms } = parseSkillMd(content);

    // Check compatibility
    let compatible = true;
    if (platforms.includes("macos") || platforms.includes("ios")) {
      compatible = false;
    }
    if (compatible && requiredBins.length > 0) {
      compatible = requiredBins.every(bin => isBinAvailable(bin));
    }

    skills.push({
      name: entry.name,
      description,
      source,
      available: true,
      disabled: false,
      compatible,
      path: skillMdPath,
    });
  }

  return skills;
}

function resolveBuiltinSkillsDir(): string {
  // 1. Explicit OPENCLAW_DIR environment variable
  if (process.env.OPENCLAW_DIR) {
    const dir = path.join(process.env.OPENCLAW_DIR, "skills");
    if (fs.existsSync(dir)) return dir;
  }
  // 2. Globally npm-installed openclaw package
  try {
    const npmRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
    const npmSkills = path.join(npmRoot, "openclaw", "skills");
    if (fs.existsSync(npmSkills)) return npmSkills;
  } catch { /* ignore */ }
  // 3. Fallback: skills/ relative to cwd (legacy mode)
  return path.resolve(process.cwd(), "skills");
}

export function skillsRoutes(config: BridgeConfig, client: BridgeGatewayClient): Router {
  const router = Router();
  const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

  const builtinSkillsDir = resolveBuiltinSkillsDir();
  const globalSkillsDir = path.join(config.openclawHome, "skills");

  // Simple cache for skills scan results (expires after 30 seconds)
  let skillsCache: { data: SkillInfo[]; timestamp: number; source: string } | null = null;
  const CACHE_TTL_MS = 30000;

  function getCachedSkills(dir: string, source: string): SkillInfo[] {
    const now = Date.now();
    if (skillsCache && skillsCache.source === source && (now - skillsCache.timestamp) < CACHE_TTL_MS) {
      return skillsCache.data;
    }
    const skills = scanSkillsDir(dir, source);
    skillsCache = { data: skills, timestamp: now, source };
    return skills;
  }

  function invalidateSkillsCache(): void {
    skillsCache = null;
  }

  // Get workspace path for a specific agent
  // main agent uses default workspace, other agents use workspace-<agentId>
  function getAgentWorkspacePath(agentId: string): string {
    if (agentId === "main" || !agentId) {
      return config.workspacePath;
    }
    return path.join(config.openclawHome, `workspace-${agentId}`);
  }

  // Get skills directory for a specific agent
  function getAgentSkillsDir(agentId: string): string {
    return path.join(getAgentWorkspacePath(agentId), "skills");
  }

  // Get skill config file path for an agent
  function getAgentSkillConfigPath(agentId: string): string {
    return path.join(getAgentWorkspacePath(agentId), ".skill-config.json");
  }

  // Read skill config (disabled_skills list) for an agent
  function getAgentSkillConfig(agentId: string): { disabled_skills: string[] } {
    const configPath = getAgentSkillConfigPath(agentId);
    try {
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, "utf-8");
        return JSON.parse(content);
      }
    } catch { /* ignore parse errors */ }
    return { disabled_skills: [] };
  }

  // Write skill config for an agent
  function setAgentSkillConfig(agentId: string, config: { disabled_skills: string[] }): void {
    const configPath = getAgentSkillConfigPath(agentId);
    const workspacePath = getAgentWorkspacePath(agentId);
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  }

  // Verify agentId signature from Platform Gateway
  function verifyAgentId(agentId: string, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = crypto
      .createHmac("sha256", config.bridgeToken)
      .update(`${agentId}:${config.bridgeToken}`)
      .digest("hex")
      .slice(0, 16);
    return signature === expected;
  }

  // Get agent ID from request header (set by platform skill) or query param (for frontend compatibility)
  // Requires signature verification to prevent tampering
  // Priority: header > query > default "main"
  function getAgentIdFromRequest(req: Request): string {
    const headerAgentId = req.headers["x-agent-id"] as string | undefined;
    const headerSig = req.headers["x-agent-id-sig"] as string | undefined;

    if (headerAgentId && /^[a-z0-9][a-z0-9_-]*$/.test(headerAgentId)) {
      // Verify signature for non-main agents
      if (headerAgentId !== "main" && !verifyAgentId(headerAgentId, headerSig)) {
        console.error(`[skills] Invalid agentId signature for ${headerAgentId}`);
        throw new Error("Invalid agentId signature");
      }
      return headerAgentId;
    }

    // Fallback to query param (also requires signature)
    const queryAgentId = req.query.agentId as string | undefined;
    const querySig = req.query.agentIdSig as string | undefined;

    if (queryAgentId && /^[a-z0-9][a-z0-9_-]*$/.test(queryAgentId)) {
      if (queryAgentId !== "main" && !verifyAgentId(queryAgentId, querySig)) {
        console.error(`[skills] Invalid agentId signature for ${queryAgentId}`);
        throw new Error("Invalid agentId signature");
      }
      return queryAgentId;
    }

    return "main";
  }

  // GET /api/skills
  router.get("/skills", asyncHandler(async (req, res) => {
    const agentId = getAgentIdFromRequest(req);

    // Get agent's disabled skills config
    const skillConfig = getAgentSkillConfig(agentId);
    const disabledSet = new Set(skillConfig.disabled_skills);

    // Use cached builtin/global skills, but always fresh scan for workspace (per-agent)
    const builtin = getCachedSkills(builtinSkillsDir, "builtin");
    const global = getCachedSkills(globalSkillsDir, "global");
    const workspaceSkillsDir = getAgentSkillsDir(agentId);
    const workspace = scanSkillsDir(workspaceSkillsDir, "workspace");

    // Priority: workspace > global > builtin (higher overrides lower)
    const skillMap = new Map<string, SkillInfo>();
    for (const s of builtin) skillMap.set(s.name, s);
    for (const s of global) skillMap.set(s.name, s);
    for (const s of workspace) skillMap.set(s.name, s);

    // Merge disabled state from gateway skills.status
    try {
      const statusReport = await client.request<{ skills?: Array<{ name?: string; skillKey?: string; disabled?: boolean }> }>("skills.status", {});
      const statusSkills = statusReport?.skills || [];
      for (const ss of statusSkills) {
        const key = ss.name || ss.skillKey || "";
        const existing = skillMap.get(key);
        if (existing && ss.disabled) {
          existing.disabled = true;
        }
      }
    } catch {
      // Gateway may not support skills.status — just return without disabled info
    }

    // Filter out skills disabled by this agent's config
    // For non-main agents, filter out skills not in their workspace that are disabled
    // For main agent, don't filter (or filter based on config)
    let skills = Array.from(skillMap.values());
    if (agentId !== "main") {
      // Non-main agents only see workspace skills + skill-creator
      skills = skills.filter(s =>
        s.source === "workspace" || s.name === "skill-creator"
      );
      // Also filter out disabled skills from the config
      skills = skills.filter(s => !disabledSet.has(s.name));
    }

    res.json(skills);
  }));

  // PUT /api/skills/:name/toggle — enable or disable a skill
  router.put("/skills/:name/toggle", asyncHandler(async (req, res) => {
    const { enabled } = req.body as { enabled: boolean };
    try {
      await client.request("skills.update", {
        skillKey: req.params.name,
        enabled,
      });
      res.json({ ok: true, name: req.params.name, enabled });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // PUT /api/skills/config — configure which skills are disabled for this agent
  router.put("/skills/config", asyncHandler(async (req, res) => {
    const agentId = getAgentIdFromRequest(req);
    const { disabled_skills } = req.body as { disabled_skills: string[] };

    if (!Array.isArray(disabled_skills)) {
      res.status(400).json({ detail: "disabled_skills must be an array" });
      return;
    }

    // Validate skill names
    for (const name of disabled_skills) {
      if (!/^[a-z0-9_-]+$/.test(name)) {
        res.status(400).json({ detail: `Invalid skill name: ${name}` });
        return;
      }
    }

    setAgentSkillConfig(agentId, { disabled_skills });
    res.json({ ok: true, agentId, disabled_skills });
  }));

  // GET /api/skills/config — get skill config for this agent
  router.get("/skills/config", asyncHandler(async (req, res) => {
    const agentId = getAgentIdFromRequest(req);
    const config = getAgentSkillConfig(agentId);
    res.json({ agentId, ...config });
  }));

  // DELETE /api/skills/:name
  router.delete("/skills/:name", asyncHandler(async (req, res) => {
    const name = req.params.name;
    const agentId = getAgentIdFromRequest(req);
    const workspaceSkillsDir = getAgentSkillsDir(agentId);
    const skillDir = path.join(workspaceSkillsDir, name);

    if (!fs.existsSync(skillDir)) {
      // Check if it's a builtin skill
      const builtinDir = path.join(builtinSkillsDir, name);
      if (fs.existsSync(builtinDir)) {
        res.status(400).json({ detail: "Cannot delete builtin skills" });
        return;
      }
      res.status(404).json({ detail: "Skill not found" });
      return;
    }

    fs.rmSync(skillDir, { recursive: true });
    res.json({ ok: true });
  }));

  // GET /api/skills/:name/download
  router.get("/skills/:name/download", asyncHandler(async (req, res) => {
    const name = req.params.name;
    const agentId = getAgentIdFromRequest(req);
    const workspaceSkillsDir = getAgentSkillsDir(agentId);

    // Check workspace first, then builtin
    let skillDir = path.join(workspaceSkillsDir, name);
    if (!fs.existsSync(skillDir)) {
      skillDir = path.join(builtinSkillsDir, name);
    }
    if (!fs.existsSync(skillDir)) {
      res.status(404).json({ detail: "Skill not found" });
      return;
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);
    archive.directory(skillDir, name);
    await archive.finalize();
  }));

  // POST /api/skills/upload
  router.post("/skills/upload", upload.single("file"), asyncHandler(async (req, res) => {
    const file = req.file;
    const agentId = getAgentIdFromRequest(req);
    const workspaceSkillsDir = getAgentSkillsDir(agentId);

    if (!file) {
      res.status(400).json({ detail: "No file provided" });
      return;
    }

    if (!file.originalname.endsWith(".zip")) {
      res.status(400).json({ detail: "File must be a .zip archive" });
      return;
    }

    // Extract zip to a temp dir, find SKILL.md
    const tmpDir = path.join(config.openclawHome, "tmp", `skill-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const directory = await unzipper.Open.buffer(file.buffer);
      await directory.extract({ path: tmpDir });

      // Find SKILL.md
      let skillMdPath: string | null = null;
      let skillName: string | null = null;

      // Check root level
      if (fs.existsSync(path.join(tmpDir, "SKILL.md"))) {
        skillMdPath = path.join(tmpDir, "SKILL.md");
        skillName = path.basename(file.originalname, ".zip");
      } else {
        // Check one level deep
        for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const mdPath = path.join(tmpDir, entry.name, "SKILL.md");
            if (fs.existsSync(mdPath)) {
              skillMdPath = mdPath;
              skillName = entry.name;
              break;
            }
          }
        }
      }

      if (!skillMdPath || !skillName) {
        res.status(400).json({ detail: "Zip must contain a SKILL.md file" });
        return;
      }

      // Move to workspace skills dir
      const destDir = path.join(workspaceSkillsDir, skillName);
      fs.mkdirSync(workspaceSkillsDir, { recursive: true });
      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true });
      }

      const sourceDir = path.dirname(skillMdPath) === tmpDir
        ? tmpDir
        : path.dirname(skillMdPath);
      fs.cpSync(sourceDir, destDir, { recursive: true });

      const content = fs.readFileSync(path.join(destDir, "SKILL.md"), "utf-8");
      const { description } = parseSkillMd(content);

      res.json({
        name: skillName,
        description,
        source: "workspace",
        available: true,
        path: path.join(destDir, "SKILL.md"),
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }));

  // GET /api/skills/platform — list platform skills (global skills visible to all users)
  router.get("/skills/platform", asyncHandler(async (_req, res) => {
    // Platform skills are global skills that all users can see (read-only)
    let platformSkills = scanSkillsDir(globalSkillsDir, "platform");

    // Fetch visibility config from gateway (if available)
    try {
      // Derive gateway URL from proxy URL
      const proxyUrl = config.proxyUrl || "";
      const gatewayBase = proxyUrl.replace("/llm/v1", "").replace(/\/+$/, "");
      if (gatewayBase) {
        const resp = await fetch(`${gatewayBase}/api/admin/skills/platform-skills`, {
          headers: {
            "Authorization": `Bearer ${config.proxyToken || ""}`,
          },
        });
        if (resp.ok) {
          const visibilityConfig: Array<{ skill_name: string; is_visible: boolean }> = await resp.json();
          const visibleSet = new Set(
            visibilityConfig.filter(s => s.is_visible).map(s => s.skill_name)
          );
          // If we have visibility config, filter to only show visible skills
          if (visibleSet.size > 0) {
            platformSkills = platformSkills.filter(s => visibleSet.has(s.name));
          }
        }
      }
    } catch {
      // If gateway is unavailable, return all platform skills
    }

    res.json(platformSkills);
  }));

  // POST /api/skills/:name/copy — copy a platform/builtin skill to user's workspace
  router.post("/skills/:name/copy", asyncHandler(async (req, res) => {
    const name = req.params.name;
    const agentId = getAgentIdFromRequest(req);
    const workspaceSkillsDir = getAgentSkillsDir(agentId);

    // Find skill in platform (global) or builtin
    let sourceDir: string | null = null;
    const platformDir = path.join(globalSkillsDir, name);
    const builtinDir = path.join(builtinSkillsDir, name);

    if (fs.existsSync(platformDir)) {
      sourceDir = platformDir;
    } else if (fs.existsSync(builtinDir)) {
      sourceDir = builtinDir;
    }

    if (!sourceDir) {
      res.status(404).json({ detail: "Skill not found in platform or builtin" });
      return;
    }

    // Copy to workspace
    const destDir = path.join(workspaceSkillsDir, name);
    fs.mkdirSync(workspaceSkillsDir, { recursive: true });
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true });
    }
    fs.cpSync(sourceDir, destDir, { recursive: true });

    const content = fs.readFileSync(path.join(destDir, "SKILL.md"), "utf-8");
    const { description } = parseSkillMd(content);

    res.json({
      name,
      description,
      source: "workspace",
      available: true,
      path: path.join(destDir, "SKILL.md"),
    });
  }));

  return router;
}
