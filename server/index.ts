import express from "express";
import { createServer } from "http";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { jsonRpcHandler, agentCardHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { agentCard, PORT } from "./agent-card.js";
import { BridgeExecutor } from "./bridge-executor.js";
import { WsBridge } from "./ws-bridge.js";

// ── WebSocket bridge ──
const bridge = new WsBridge();

// ── A2A handler ──
const taskStore = new InMemoryTaskStore();
const executor = new BridgeExecutor(bridge);
const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

// ── Express app ──
const app = express();

// Health check
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    extensionConnected: bridge.connected,
  });
});

// A2A Agent Card — serve at both standard and sub-path locations
const cardMiddleware = agentCardHandler({ agentCardProvider: requestHandler });
app.use("/.well-known/agent-card.json", cardMiddleware);
app.use("/a2a/.well-known/agent-card.json", cardMiddleware);

// A2A JSON-RPC endpoint
app.use(
  "/a2a",
  jsonRpcHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
  })
);

// ── HTTP + WS server ──
const server = createServer(app);
bridge.attach(server);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`
╔════════════════════════════════════════════╗
║  Web Agent Bridge – A2A Server (v1.0)      ║
╠════════════════════════════════════════════╣
║  HTTP:  http://127.0.0.1:${PORT}             ║
║  A2A:   http://127.0.0.1:${PORT}/a2a         ║
║  WS:    ws://127.0.0.1:${PORT}/ws            ║
║  Card:  http://127.0.0.1:${PORT}/a2a/.well-known/agent-card.json
╚════════════════════════════════════════════╝
  `);
});
