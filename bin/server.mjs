#!/usr/bin/env node

/**
 * CLI entry point for `npx web-agent-bridge`.
 * Launches the A2A server with tsx for TypeScript support.
 */

import { execSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const serverEntry = join(root, "server", "index.ts");

if (!existsSync(serverEntry)) {
  console.error("❌ Cannot find server/index.ts — are you in the project root?");
  process.exit(1);
}

// Parse CLI args
const args = process.argv.slice(2);
let port = 3000;
for (let i = 0; i < args.length; i++) {
  if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  }
}

console.log(`
  ╔═══════════════════════════════════════════╗
  ║         Web Agent Bridge  v0.3.0         ║
  ╠═══════════════════════════════════════════╣
  ║                                           ║
  ║  A2A Server:  http://127.0.0.1:${String(port).padEnd(5)}     ║
  ║  Agent Card:  /.well-known/agent-card.json║
  ║  WebSocket:   ws://127.0.0.1:${String(port).padEnd(5)}/ws   ║
  ║                                           ║
  ║  Next steps:                              ║
  ║  1. Install browser extension             ║
  ║  2. Open an AI agent page (Doubao, etc.)  ║
  ║  3. Send messages via A2A client          ║
  ║                                           ║
  ╚═══════════════════════════════════════════╝
`);

const env = { ...process.env, PORT: String(port) };

const child = spawn(
  process.execPath,
  ["--import", "tsx", serverEntry],
  { env, stdio: "inherit", cwd: root }
);

child.on("exit", (code) => process.exit(code ?? 1));

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
