import crypto, { randomUUID } from "node:crypto";
import express from "express";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { BridgeConfig } from "./config.js";
import type { BridgeGatewayClient, GatewayEvent } from "./gateway-client.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { statusRoutes } from "./routes/status.js";
import { filesRoutes } from "./routes/files.js";
import { workspaceRoutes } from "./routes/workspace.js";
import { skillsRoutes } from "./routes/skills.js";
import { commandsRoutes } from "./routes/commands.js";
import { pluginsRoutes } from "./routes/plugins.js";
import { cronRoutes } from "./routes/cron.js";
import { agentsRoutes } from "./routes/agents.js";
import { marketplacesRoutes } from "./routes/marketplaces.js";
import { filemanagerRoutes } from "./routes/filemanager.js";
import { channelsRoutes } from "./routes/channels.js";
import { settingsRoutes } from "./routes/settings.js";
import { nodesRoutes } from "./routes/nodes.js";
import { curatedSkillsRoutes } from "./routes/curated-skills.js";
import { reviewRoutes } from "./routes/reviews.js";

export function createServer(client: BridgeGatewayClient, config: BridgeConfig): http.Server {
  const app = express();

  // Middleware
  app.use(express.json({ limit: "50mb" }));

  // Mount routes
  app.use("/api", sessionsRoutes(client));
  app.use("/api", statusRoutes(client, config));
  app.use("/api", filesRoutes(config));
  app.use("/api", workspaceRoutes(config));
  app.use("/api", skillsRoutes(config, client));
  app.use("/api", commandsRoutes(config));
  app.use("/api", pluginsRoutes(config));
  app.use("/api", cronRoutes(client));
  app.use("/api", agentsRoutes(client, config));
  app.use("/api", marketplacesRoutes(config));
  app.use("/api", filemanagerRoutes(config));
  app.use("/api", channelsRoutes(client, config));
  app.use("/api", settingsRoutes(config));
  app.use("/api", nodesRoutes(client));
  app.use("/api", curatedSkillsRoutes(config));
  app.use("/api", reviewRoutes(config));

  // Error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[bridge] Error:", err.message);
    res.status(500).json({ detail: err.message });
  });

  // Create HTTP server
  const server = http.createServer(app);

  // WebSocket relay: Use BridgeGatewayClient's connection to forward events
  // This avoids needing separate device pairing for each WebSocket connection
  const wss = new WebSocketServer({ server, path: "/ws" });

  // Store connected downstream WebSocket clients with their agentId
  const downstreamClients = new Map<WebSocket, string>();

  // Forward gateway events to all connected downstream clients
  client.onEvent((evt: GatewayEvent) => {
    const message = JSON.stringify(evt);
    // Debug: log chat events with payload details
    if (evt.event === "chat") {
      console.log(`[ws-relay] CHAT event: ${JSON.stringify(evt.payload)}`);
    }
    for (const [ws, agentId] of downstreamClients) {
      if (ws.readyState === WebSocket.OPEN) {
        // Filter events by agentId if needed
        // For chat events, check if the sessionKey matches the agent's sessions
        if (evt.event?.startsWith("chat.") && evt.payload?.sessionKey) {
          const sessionKey = evt.payload.sessionKey as string;
          // Check if this session belongs to this agent
          // Session key format: agent:<agentId>:<sessionKey>
          if (sessionKey.startsWith(`agent:${agentId}:`) || !sessionKey.startsWith("agent:")) {
            ws.send(message);
          }
        } else {
          // Non-chat events go to all clients
          ws.send(message);
        }
      }
    }
  });

  // Verify isAdmin signature from Platform Gateway
  function verifyIsAdmin(agentId: string, isAdmin: boolean, signature: string | null): boolean {
    if (!signature) return false;
    const expected = crypto
      .createHmac("sha256", config.bridgeToken)
      .update(`${agentId}:${isAdmin}:${config.bridgeToken}`)
      .digest("hex")
      .slice(0, 16);
    return signature === expected;
  }

  wss.on("connection", (downstream, request) => {
    // Extract agentId and isAdmin from URL query parameters
    const requestUrl = request.url || "/";
    const host = request.headers.host || "localhost";
    const url = new URL(requestUrl, `http://${host}`);
    const agentId = url.searchParams.get("agentId") || "";
    const rawIsAdmin = url.searchParams.get("isAdmin") === "true";
    const isAdminSig = url.searchParams.get("isAdminSig");

    // Verify isAdmin signature to prevent tampering
    const isAdmin = verifyIsAdmin(agentId, rawIsAdmin, isAdminSig);
    if (rawIsAdmin && !isAdmin) {
      console.error(`[ws-relay] Invalid isAdmin signature from agentId=${agentId}, rejecting connection`);
      downstream.close(4003, "Invalid isAdmin signature");
      return;
    }

    // Register this client with agentId and admin status
    downstreamClients.set(downstream, agentId);
    console.log(`[ws-relay] Client connected, agentId=${agentId}, isAdmin=${isAdmin}, total clients=${downstreamClients.size}`);

    downstream.on("message", (data) => {
      // Parse the message and forward to gateway via RPC
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "req" && msg.method && msg.params) {
          // This is an RPC request, forward via the gateway client
          client.request(msg.method, msg.params)
            .then((result) => {
              const response = { type: "res", id: msg.id, ok: true, payload: result };
              if (downstream.readyState === WebSocket.OPEN) {
                downstream.send(JSON.stringify(response));
              }
            })
            .catch((err) => {
              const response = {
                type: "res",
                id: msg.id,
                ok: false,
                error: { code: "ERROR", message: err.message },
              };
              if (downstream.readyState === WebSocket.OPEN) {
                downstream.send(JSON.stringify(response));
              }
            });
        } else if (msg.type === "ping") {
          downstream.send(JSON.stringify({ type: "pong" }));
        }
      } catch {
        // Invalid JSON, ignore
      }
    });

    downstream.on("close", () => {
      downstreamClients.delete(downstream);
      console.log(`[ws-relay] Client disconnected, total clients=${downstreamClients.size}`);
    });

    downstream.on("error", (err) => {
      console.error("[ws-relay] Downstream error:", err.message);
      downstreamClients.delete(downstream);
    });

    // Send periodic ping to keep connection alive (prevent proxy timeouts)
    const pingInterval = setInterval(() => {
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000); // 30 seconds

    downstream.on("close", () => {
      clearInterval(pingInterval);
    });
  });

  return server;
}
