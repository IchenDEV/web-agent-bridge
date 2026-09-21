import express from "express";
import { createServer } from "http";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { jsonRpcHandler, agentCardHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { agentCard, PORT } from "./agent-card.js";
import { BridgeExecutor } from "./bridge-executor.js";
import { WsBridge } from "./ws-bridge.js";
import { BackendRouter } from "./message-backend.js";

// ── Parse CLI flags from environment ──
const ENABLE_BROWSER = process.env.ENABLE_BROWSER === "1";
const BROWSER_ONLY = process.env.BROWSER_ONLY === "1";
const CDP_URL = process.env.CDP_URL || undefined;
const ENABLE_ACP = process.env.ENABLE_ACP === "1";

async function main() {
  // ── Backend router ──
  const router = new BackendRouter(BROWSER_ONLY ? "browser" : "extension");

  // ── Extension backend (WsBridge) ──
  let bridge: WsBridge | null = null;
  if (!BROWSER_ONLY) {
    bridge = new WsBridge();
    router.register(bridge);
  }

  // ── Browser backend (awaited so /health is accurate) ──
  if (ENABLE_BROWSER || BROWSER_ONLY) {
    try {
      const { BrowserBackend } = await import("./browser-backend.js");
      const browserBackend = new BrowserBackend();
      await browserBackend.connect(CDP_URL);
      router.register(browserBackend);
      console.log(`[Server] Browser backend connected${CDP_URL ? ` (CDP: ${CDP_URL})` : ""}`);
    } catch (err: any) {
      console.error(`[Server] Failed to start browser backend: ${err.message}`);
      if (BROWSER_ONLY) {
        console.error("[Server] BROWSER_ONLY mode requires a working browser backend. Exiting.");
        process.exit(1);
      }
    }
  }

  // ── A2A handler ──
  const taskStore = new InMemoryTaskStore();
  const executor = new BridgeExecutor(router);
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

  // ── Express app ──
  const app = express();

  app.get("/health", (_req, res) => {
    const backends = router.status();
    res.json({
      ok: true,
      extensionConnected: backends.extension?.connected ?? false,
      backends,
    });
  });

  const cardMiddleware = agentCardHandler({ agentCardProvider: requestHandler });
  app.use("/.well-known/agent-card.json", cardMiddleware);
  app.use("/a2a/.well-known/agent-card.json", cardMiddleware);

  app.use(
    "/a2a",
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );

  const server = createServer(app);

  if (bridge) {
    bridge.attach(server);
  }

  if (ENABLE_ACP) {
    try {
      const { mountAcpEndpoint } = await import("./acp-http.js");
      mountAcpEndpoint(server, app, router);
      console.log(`[Server] ACP endpoint enabled at /acp`);
    } catch (err: any) {
      console.error(`[Server] Failed to mount ACP endpoint: ${err.message}`);
    }
  }

  server.listen(PORT, "127.0.0.1", () => {
    const lines = [
      "╔════════════════════════════════════════════════╗",
      "║  Web Agent Bridge – Server                      ║",
      "╠════════════════════════════════════════════════╣",
      `║  HTTP:  http://127.0.0.1:${PORT}                 ║`,
      `║  A2A:   http://127.0.0.1:${PORT}/a2a             ║`,
    ];
    if (bridge) {
      lines.push(`║  WS:    ws://127.0.0.1:${PORT}/ws              ║`);
    }
    if (ENABLE_ACP) {
      lines.push(`║  ACP:   http://127.0.0.1:${PORT}/acp            ║`);
    }
    lines.push(`║  Card:  http://127.0.0.1:${PORT}/a2a/.well-known/agent-card.json`);

    const backends = [];
    if (!BROWSER_ONLY) backends.push("extension");
    if (ENABLE_BROWSER || BROWSER_ONLY) backends.push("browser");
    lines.push(`║  Backends: ${backends.join(" + ")}`.padEnd(48) + "║");

    lines.push("╚════════════════════════════════════════════════╝");
    console.log("\n" + lines.join("\n") + "\n");
  });
}

main().catch((err) => {
  console.error("[Server] Fatal:", err);
  process.exit(1);
});
