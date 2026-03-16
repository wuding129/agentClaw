import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import mime from "mime-types";
import type { BridgeConfig } from "../config.js";
import { asyncHandler, sanitizePath } from "../utils.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Fix multer's latin1-encoded originalname for non-ASCII filenames (e.g. Chinese).
 * Browsers send UTF-8 filenames, but multer decodes them as latin1 by default.
 */
function fixOriginalName(raw: string): string {
  try {
    return Buffer.from(raw, "latin1").toString("utf8");
  } catch {
    return raw;
  }
}

/**
 * Get the root directory for a specific agent.
 * main agent uses ~/.openclaw/workspace, others use ~/.openclaw/workspace-{agentId}
 */
function getAgentRootDir(baseDir: string, agentId: string | undefined): string {
  if (!agentId || agentId === "main") {
    return path.join(baseDir, "workspace");
  }
  return path.join(baseDir, `workspace-${agentId}`);
}

/**
 * List all agent workspace directories (for admin use)
 */
function listAllAgentWorkspaces(baseDir: string): Array<{ id: string; path: string }> {
  const workspaces: Array<{ id: string; path: string }> = [];

  // Add main workspace if exists
  const mainWorkspace = path.join(baseDir, "workspace");
  if (fs.existsSync(mainWorkspace)) {
    workspaces.push({ id: "main", path: "/workspace" });
  }

  // Add all workspace-{agentId} directories
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith("workspace-")) {
      const agentId = entry.name.substring("workspace-".length);
      if (agentId !== "main") {  // main is already added above
        workspaces.push({ id: agentId, path: `/workspace-${agentId}` });
      }
    }
  }

  return workspaces;
}

export function filemanagerRoutes(config: BridgeConfig): Router {
  const router = Router();
  const upload = multer({ limits: { fileSize: MAX_FILE_SIZE } });
  const baseDir = config.openclawHome;

  // GET /api/filemanager/agents — list all agent workspaces (admin only)
  router.get("/filemanager/agents", asyncHandler(async (req, res) => {
    const isAdmin = req.headers["x-is-admin"] === "true";

    if (!isAdmin) {
      res.status(403).json({ detail: "Admin access required" });
      return;
    }

    const workspaces = listAllAgentWorkspaces(baseDir);
    res.json({ workspaces });
  }));

  // GET /api/filemanager/browse?path=&agentId= (admin can specify agentId)
  router.get("/filemanager/browse", asyncHandler(async (req, res) => {
    const requestAgentId = req.headers["x-agent-id"] as string | undefined;
    const isAdmin = req.headers["x-is-admin"] === "true";
    // Admin can specify which agent's workspace to browse
    let agentId = requestAgentId;
    if (isAdmin && req.query.agentId) {
      agentId = req.query.agentId as string;
    }

    const rootDir = getAgentRootDir(baseDir, agentId);
    const relPath = (req.query.path as string) || "";
    const absPath = relPath ? sanitizePath(relPath, rootDir) : rootDir;

    if (!absPath) {
      res.status(400).json({ detail: "Invalid path" });
      return;
    }

    // If root directory doesn't exist, create it (first time access)
    if (!relPath && !fs.existsSync(rootDir)) {
      fs.mkdirSync(rootDir, { recursive: true });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      res.status(404).json({ detail: "Path not found" });
      return;
    }

    // If it's a file, return its content (text files only, capped at 200KB)
    if (stat.isFile()) {
      const contentType = mime.lookup(path.basename(absPath)) || "application/octet-stream";
      const isText = contentType.startsWith("text/") ||
        contentType === "application/json" ||
        contentType === "application/xml" ||
        absPath.endsWith(".md") ||
        absPath.endsWith(".yml") ||
        absPath.endsWith(".yaml") ||
        absPath.endsWith(".toml") ||
        absPath.endsWith(".jsonl") ||
        absPath.endsWith(".py") ||
        absPath.endsWith(".sh") ||
        absPath.endsWith(".js") ||
        absPath.endsWith(".ts");

      if (isText && stat.size <= 200 * 1024) {
        const content = fs.readFileSync(absPath, "utf-8");
        res.json({
          type: "file",
          path: relPath,
          name: path.basename(absPath),
          size: stat.size,
          content_type: contentType,
          modified: stat.mtime.toISOString(),
          content,
        });
        return;
      }

      res.json({
        type: "file",
        path: relPath,
        name: path.basename(absPath),
        size: stat.size,
        content_type: contentType,
        modified: stat.mtime.toISOString(),
      });
      return;
    }

    if (!stat.isDirectory()) {
      res.status(400).json({ detail: "Path is not a file or directory" });
      return;
    }

    const entries = fs.readdirSync(absPath, { withFileTypes: true });

    const items = [];
    for (const e of entries) {
      const itemAbsPath = path.join(absPath, e.name);
      let itemStat: fs.Stats;
      try {
        itemStat = fs.statSync(itemAbsPath);
      } catch { continue; }

      const itemRelPath = path.relative(rootDir, itemAbsPath);
      const isDir = itemStat.isDirectory();

      items.push({
        name: e.name,
        path: itemRelPath,
        type: isDir ? "directory" : "file",
        size: isDir ? null : itemStat.size,
        content_type: isDir ? null : (mime.lookup(e.name) || "application/octet-stream"),
        modified: itemStat.mtime.toISOString(),
      });
    }

    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    // Return virtual root path instead of exposing the actual filesystem path
    const virtualRoot = "/workspace";
    res.json({ type: "directory", path: relPath || "/", root: virtualRoot, items });
  }));

  // GET /api/filemanager/download?path=&agentId= (admin can specify agentId)
  router.get("/filemanager/download", asyncHandler(async (req, res) => {
    const requestAgentId = req.headers["x-agent-id"] as string | undefined;
    const isAdmin = req.headers["x-is-admin"] === "true";
    let agentId = requestAgentId;
    if (isAdmin && req.query.agentId) {
      agentId = req.query.agentId as string;
    }

    const rootDir = getAgentRootDir(baseDir, agentId);
    const relPath = req.query.path as string;
    if (!relPath) {
      res.status(400).json({ detail: "Path is required" });
      return;
    }

    const absPath = sanitizePath(relPath, rootDir);
    if (!absPath || !fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) {
      res.status(404).json({ detail: "File not found" });
      return;
    }

    const fileName = path.basename(absPath);
    const contentType = mime.lookup(fileName) || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
    fs.createReadStream(absPath).pipe(res);
  }));

  // POST /api/filemanager/upload  (multipart, body.path = target dir, admin can specify agentId)
  router.post("/filemanager/upload", upload.single("file"), asyncHandler(async (req, res) => {
    const requestAgentId = req.headers["x-agent-id"] as string | undefined;
    const isAdmin = req.headers["x-is-admin"] === "true";
    let agentId = requestAgentId;
    if (isAdmin && req.body.agentId) {
      agentId = req.body.agentId as string;
    }

    const rootDir = getAgentRootDir(baseDir, agentId);
    const file = req.file;
    if (!file || !file.originalname) {
      res.status(400).json({ detail: "No file provided" });
      return;
    }

    const fileName = fixOriginalName(file.originalname);

    const targetDir = (req.body.path as string) || "";
    const absDirPath = targetDir ? sanitizePath(targetDir, rootDir) : rootDir;
    if (!absDirPath) {
      res.status(400).json({ detail: "Invalid path" });
      return;
    }

    if (fileName.includes("/") || fileName.includes("\\")) {
      res.status(400).json({ detail: "Invalid filename" });
      return;
    }

    fs.mkdirSync(absDirPath, { recursive: true });
    const filePath = path.join(absDirPath, fileName);
    fs.writeFileSync(filePath, file.buffer);
    const stat = fs.statSync(filePath);

    res.json({
      name: fileName,
      path: path.relative(rootDir, filePath),
      type: "file",
      size: stat.size,
      modified: stat.mtime.toISOString(),
    });
  }));

  // DELETE /api/filemanager/delete?path=&agentId= (admin can specify agentId)
  router.delete("/filemanager/delete", asyncHandler(async (req, res) => {
    const requestAgentId = req.headers["x-agent-id"] as string | undefined;
    const isAdmin = req.headers["x-is-admin"] === "true";
    let agentId = requestAgentId;
    if (isAdmin && req.query.agentId) {
      agentId = req.query.agentId as string;
    }

    const rootDir = getAgentRootDir(baseDir, agentId);
    const relPath = req.query.path as string;
    if (!relPath) {
      res.status(400).json({ detail: "Path is required" });
      return;
    }

    const absPath = sanitizePath(relPath, rootDir);
    if (!absPath || !fs.existsSync(absPath)) {
      res.status(404).json({ detail: "Path not found" });
      return;
    }

    // Prevent deleting the root itself
    if (absPath === rootDir) {
      res.status(400).json({ detail: "Cannot delete root directory" });
      return;
    }

    fs.rmSync(absPath, { recursive: true });
    res.json({ ok: true });
  }));

  // POST /api/filemanager/mkdir?path=&agentId= (admin can specify agentId)
  router.post("/filemanager/mkdir", asyncHandler(async (req, res) => {
    const requestAgentId = req.headers["x-agent-id"] as string | undefined;
    const isAdmin = req.headers["x-is-admin"] === "true";
    let agentId = requestAgentId;
    if (isAdmin && req.query.agentId) {
      agentId = req.query.agentId as string;
    }

    const rootDir = getAgentRootDir(baseDir, agentId);
    const relPath = req.query.path as string;
    if (!relPath) {
      res.status(400).json({ detail: "Path is required" });
      return;
    }

    const absPath = sanitizePath(relPath, rootDir);
    if (!absPath) {
      res.status(400).json({ detail: "Invalid path" });
      return;
    }

    fs.mkdirSync(absPath, { recursive: true });
    res.json({ name: path.basename(absPath), path: relPath, type: "directory" });
  }));

  // PUT /api/filemanager/update?path=&agentId= — update file content
  router.put("/filemanager/update", asyncHandler(async (req, res) => {
    const requestAgentId = req.headers["x-agent-id"] as string | undefined;
    const isAdmin = req.headers["x-is-admin"] === "true";
    let agentId = requestAgentId;
    if (isAdmin && req.query.agentId) {
      agentId = req.query.agentId as string;
    }

    const rootDir = getAgentRootDir(baseDir, agentId);
    const relPath = req.query.path as string;
    if (!relPath) {
      res.status(400).json({ detail: "Path is required" });
      return;
    }

    const absPath = sanitizePath(relPath, rootDir);
    if (!absPath) {
      res.status(400).json({ detail: "Invalid path" });
      return;
    }

    // Check if file exists and is a file
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      res.status(404).json({ detail: "File not found" });
      return;
    }

    const { content } = req.body as { content: string };
    if (content === undefined) {
      res.status(400).json({ detail: "Content is required" });
      return;
    }

    fs.writeFileSync(absPath, content, "utf-8");
    const stat = fs.statSync(absPath);

    res.json({
      name: path.basename(absPath),
      path: relPath,
      type: "file",
      size: stat.size,
      modified: stat.mtime.toISOString(),
    });
  }));

  return router;
}
