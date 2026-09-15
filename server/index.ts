import express from "express";
import { createServer } from "http";
import { A2AExpressApp, DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
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

// Mount A2A routes at /a2a (JSON-RPC endpoint + Agent Card)
// Cast needed: SDK bundles its own @types/express version
const a2aApp = new A2AExpressApp(requestHandler);
a2aApp.setupRoutes(app as any, "/a2a");

// ── HTTP + WS server ──
const server = createServer(app);
bridge.attach(server);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`
╔════════════════════════════════════════════╗
║  Web Agent Bridge – A2A Server             ║
╠════════════════════════════════════════════╣
║  HTTP:  http://127.0.0.1:${PORT}             ║
║  A2A:   http://127.0.0.1:${PORT}/a2a         ║
║  WS:    ws://127.0.0.1:${PORT}/ws            ║
║  Card:  http://127.0.0.1:${PORT}/a2a/.well-known/agent.json
╚════════════════════════════════════════════╝
  `);
});
