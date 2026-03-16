import { Router } from "express";
import type { BridgeGatewayClient } from "../gateway-client.js";
import { randomUUID } from "node:crypto";
import { asyncHandler, toOpenclawSessionKey, toFrameclawSessionId, extractTextContent } from "../utils.js";

// ---------------------------------------------------------------------------
// Constants (to prevent typos and magic values)
// ---------------------------------------------------------------------------

/** Session visibility scopes */
const SessionScope = {
  Self: "self",
  All: "all",
} as const;

interface OpenclawSessionRow {
  key: string;
  updatedAt: number | null;
  [key: string]: unknown;
}

interface OpenclawSessionsListResult {
  sessions: OpenclawSessionRow[];
  [key: string]: unknown;
}

interface OpenclawChatHistoryResult {
  messages: Array<{
    role: string;
    content: unknown;
    timestamp?: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export function sessionsRoutes(client: BridgeGatewayClient): Router {
  const router = Router();

  // GET /api/sessions — list sessions
  router.get("/sessions", asyncHandler(async (req, res) => {
    // Extract agentId from header for multi-agent routing
    const agentId = req.headers["x-agent-id"] as string | undefined;
    const isAdmin = req.headers["x-is-admin"] === "true";
    // scope=self: only return current user's sessions (for chat sidebar)
    const scope = req.query.scope as string | undefined;
    // Admin can specify which agent's sessions to view
    let targetAgentId = agentId;
    if (isAdmin && req.query.agentId) {
      targetAgentId = req.query.agentId as string;
    } else if (isAdmin && scope === SessionScope.Self) {
      // Admin in chat mode: only see own sessions
      targetAgentId = agentId;
    } else if (isAdmin && !req.query.agentId) {
      // Admin without specific agentId and no scope: get all sessions
      targetAgentId = undefined;
    }

    try {
      const params: Record<string, unknown> = {
        includeLastMessage: true,
        includeDerivedTitles: true,
      };
      // Only pass agentId if specified (for filtering)
      if (targetAgentId) {
        params.agentId = targetAgentId;
      }
      const result = await client.request<OpenclawSessionsListResult>("sessions.list", params);

      const sessions = (result.sessions || []).map((s: OpenclawSessionRow) => {
        // Extract display-friendly session name from agent:{agentId}:{sessionKey}
        let displayTitle = s.derivedTitle || s.displayName;
        let sessionAgentId = "";
        if (s.key.startsWith("agent:")) {
          const parts = s.key.split(":");
          if (parts.length >= 3) {
            sessionAgentId = parts[1];
            displayTitle = displayTitle || parts.slice(2).join(":");
          }
        }
        return {
          key: toFrameclawSessionId(s.key),
          agentId: sessionAgentId,
          created_at: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
          updated_at: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
          title: displayTitle,
        };
      });

      res.json(sessions);
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // GET /api/sessions/:key — get session detail with messages
  router.get("/sessions/:key(*)", asyncHandler(async (req, res) => {
    const agentId = req.headers["x-agent-id"] as string | undefined;
    const key = toOpenclawSessionKey(req.params.key, agentId);

    try {
      const history = await client.request<OpenclawChatHistoryResult>("chat.history", {
        sessionKey: key,
        limit: 200,
      });

      // Filter: only user and assistant messages (skip tool, system)
      // Also filter intermediate assistant messages that have tool_calls or empty content
      const messages = (history.messages || [])
        .filter((m) => m.role === "user" || m.role === "assistant")
        .filter((m) => {
          if (m.role !== "assistant") return true;
          // Skip assistant messages that are just tool calls
          if (m.tool_calls) return false;
          // Skip assistant messages with empty content (intermediate agent loop artifacts)
          const text = extractTextContent(m.content);
          if (!text.trim()) return false;
          return true;
        })
        .map((m) => ({
          role: m.role,
          content: extractTextContent(m.content),
          timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : null,
        }));

      // Determine timestamps from messages
      const firstMsg = messages[0];
      const lastMsg = messages[messages.length - 1];

      res.json({
        key: toFrameclawSessionId(key),
        messages,
        created_at: firstMsg?.timestamp || null,
        updated_at: lastMsg?.timestamp || null,
      });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // POST /api/sessions/:key/messages — send a chat message
  router.post("/sessions/:key(*)/messages", asyncHandler(async (req, res) => {
    const agentId = req.headers["x-agent-id"] as string | undefined;
    const key = toOpenclawSessionKey(req.params.key, agentId);
    const { message } = req.body;

    if (!message || typeof message !== "string") {
      res.status(400).json({ detail: "message is required" });
      return;
    }

    try {
      const params: Record<string, unknown> = {
        sessionKey: key,
        message,
        deliver: false,
        idempotencyKey: randomUUID(),
      };

      const result = await client.request<Record<string, unknown>>("chat.send", params);
      res.json({ ok: true, runId: result.runId || null });
    } catch (err) {
      res.status(500).json({ detail: (err as Error).message });
    }
  }));

  // DELETE /api/sessions/:key — delete session
  router.delete("/sessions/:key(*)", asyncHandler(async (req, res) => {
    const agentId = req.headers["x-agent-id"] as string | undefined;
    const key = toOpenclawSessionKey(req.params.key, agentId);

    try {
      await client.request("sessions.delete", { key });
      res.json({ ok: true });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found") || msg.includes("INVALID_REQUEST")) {
        res.status(404).json({ detail: "Session not found" });
      } else {
        res.status(500).json({ detail: msg });
      }
    }
  }));

  return router;
}
