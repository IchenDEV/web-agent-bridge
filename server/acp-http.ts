import type { Server as HttpServer, IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { Express } from "express";
import { WebSocketServer } from "ws";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import {
  createNodeHttpHandler,
  createNodeWebSocketUpgradeHandler,
} from "@agentclientprotocol/sdk/experimental/node";
import type { MessageBackend } from "./message-backend.js";
import { createWebAgentApp } from "./acp-agent.js";

/**
 * Mount ACP Streamable HTTP and WebSocket on `/acp`.
 * The Chrome-extension WebSocket stays on `/ws`.
 */
export function mountAcpEndpoint(
  httpServer: HttpServer,
  app: Express,
  backend: MessageBackend,
): void {
  const acpServer = new AcpServer({ agent: createWebAgentApp(backend) });
  const httpHandler = createNodeHttpHandler(acpServer);
  const webSocketServer = new WebSocketServer({ noServer: true });
  const upgradeHandler = createNodeWebSocketUpgradeHandler(acpServer, webSocketServer);

  app.use("/acp", (req, res) => {
    req.url = req.originalUrl || req.url;
    httpHandler(req, res);
  });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== "/acp") return;
    upgradeHandler(req, socket, head);
  });
}
