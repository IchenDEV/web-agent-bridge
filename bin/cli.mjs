#!/usr/bin/env node

/**
 * wab — Web Agent Bridge CLI
 *
 * Usage:
 *   wab server  [-p port] [--browser] [--acp]   Start the server
 *   wab send    [-a agent] [-b backend] "msg"  Send a message, print response
 *   wab acp     [-b backend]                   ACP agent on stdin/stdout
 *   wab login   [agent]                        Log in via Playwright
 *   wab agent   [-s url]                       Show Agent Card
 *   wab health  [-s url]                       Check connection status
 *   wab pack                                   Package extension as ZIP
 *   wab publish [--dry-run]                    Publish to npm
 *
 * AI agents can call `wab send` and parse stdout — no HTTP needed.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const DEFAULT_SERVER = "http://127.0.0.1:3000";
const VERSION = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version;

const KNOWN_AGENTS = ["doubao", "workbuddy", "chatgpt", "gemini", "perplexity", "kimi", "qianwen"];

// ── Arg parsing ──

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name, short) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === name || args[i] === short) && args[i + 1]) {
      return args[i + 1];
    }
  }
  return null;
}

function hasFlag(name, short) {
  return args.includes(name) || args.includes(short);
}

function getServerUrl() {
  return getFlag("--server", "-s") || process.env.WAB_SERVER || process.env.WEB_AGENT_BRIDGE_URL || DEFAULT_SERVER;
}

const jsonMode = hasFlag("--json", "-j");

// ── Helpers ──

function flagValues() {
  const flagged = new Set();
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("-") && args[i + 1] && !args[i + 1].startsWith("-")) {
      flagged.add(args[i + 1]);
      i++;
    }
  }
  return flagged;
}

// ── server ──

async function cmdServer() {
  const port = getFlag("--port", "-p") || process.env.PORT || "3000";
  const serverEntry = join(root, "server", "index.ts");

  if (!existsSync(serverEntry)) {
    console.error("❌ Cannot find server/index.ts");
    process.exit(1);
  }

  const browserOnly = hasFlag("--browser-only", null);
  const enableBrowser = browserOnly || hasFlag("--browser", null) || args.includes("--cdp");
  const enableAcp = hasFlag("--acp", null);
  const cdp = cdpUrl();

  console.log(`
  ╔════════════════════════════════════════╗
  ║       Web Agent Bridge  v${VERSION.padEnd(8)}   ║
  ╠════════════════════════════════════════╣
  ║  A2A:   http://127.0.0.1:${String(port).padEnd(5)}      ║
  ║  WS:    ws://127.0.0.1:${String(port).padEnd(5)}/ws    ║${enableAcp ? `\n  ║  ACP:   http://127.0.0.1:${String(port).padEnd(5)}/acp   ║` : ""}
  ╚════════════════════════════════════════╝
`);

  const env = {
    ...process.env,
    PORT: String(port),
    ENABLE_BROWSER: enableBrowser ? "1" : "",
    BROWSER_ONLY: browserOnly ? "1" : "",
    ENABLE_ACP: enableAcp ? "1" : "",
  };
  if (cdp) env.CDP_URL = cdp;

  const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    env, stdio: "inherit", cwd: root,
  });
  child.on("exit", (code) => process.exit(code ?? 1));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

function cdpUrl() {
  const idx = args.indexOf("--cdp");
  if (idx === -1) return "";
  const next = args[idx + 1];
  if (next && !next.startsWith("-")) return next;
  return "auto";
}

// ── cdp (attach Dia / discover) ──

async function cmdCdp() {
  const entry = join(root, "server", "cdp-attach-dia.ts");
  if (!existsSync(entry)) {
    console.error("❌ Cannot find server/cdp-attach-dia.ts");
    process.exit(1);
  }
  console.error("Attaching CDP to Dia (will briefly restart Dia, login state kept)...");
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    env: process.env, stdio: "inherit", cwd: root,
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

// ── agent ──

async function cmdAgent() {
  const url = getServerUrl();
  try {
    const resp = await fetch(`${url}/.well-known/agent-card.json`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const card = await resp.json();

    if (jsonMode) { console.log(JSON.stringify(card, null, 2)); return; }

    console.log(`\n🤖 ${card.name}  v${card.version}`);
    console.log(`   ${card.description}\n`);

    if (card.skills?.length) {
      console.log(`   Skills:`);
      for (const s of card.skills) {
        console.log(`     • ${s.name} (${s.id})`);
        if (s.description) console.log(`       ${s.description}`);
      }
    }
    console.log();
  } catch (e) {
    console.error(`❌ Cannot reach ${url}: ${e.message}`);
    process.exit(1);
  }
}

// ── health ──

async function cmdHealth() {
  const url = getServerUrl();
  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();

    if (jsonMode) { console.log(JSON.stringify(data, null, 2)); return; }

    const serverOk = data.ok ? "✅" : "❌";
    const extOk = data.extensionConnected ? "✅" : "❌";
    console.log(`\n  Server:    ${serverOk} ${data.ok ? "running" : "error"}`);
    console.log(`  Extension: ${extOk} ${data.extensionConnected ? "connected" : "not connected"}`);
    if (data.backends && typeof data.backends === "object") {
      for (const [name, info] of Object.entries(data.backends)) {
        const connected = info && typeof info === "object" && info.connected;
        console.log(`  ${name}: ${connected ? "✅ connected" : "❌ not connected"}`);
      }
    }
    console.log();

    if (!data.extensionConnected) {
      console.log("  💡 Open an AI agent page and ensure the extension is loaded.");
      console.log();
    }
  } catch (e) {
    console.error(`❌ Server not reachable at ${url}`);
    console.error("   Start it with: wab server");
    process.exit(1);
  }
}

// ── send ──

async function cmdSend() {
  const url = getServerUrl();
  const agent = getFlag("--agent", "-a") || undefined;
  const backend = getFlag("--backend", "-b") || undefined;
  const contextId = getFlag("--context", "-c") || crypto.randomUUID();
  const taskId = getFlag("--task", "-t") || "";
  const timeout = parseInt(getFlag("--timeout", "-T") || "180", 10) * 1000;

  if (agent && !KNOWN_AGENTS.includes(agent)) {
    console.error(`❌ Unknown agent "${agent}". Available: ${KNOWN_AGENTS.join(", ")}`);
    process.exit(1);
  }
  if (backend && backend !== "extension" && backend !== "browser") {
    console.error(`❌ Unknown backend "${backend}". Available: extension, browser`);
    process.exit(1);
  }

  // Collect message: -m "text" / positional / stdin
  let message = getFlag("--message", "-m");
  if (!message) {
    const fv = flagValues();
    let afterSend = false;
    for (const a of args) {
      if (a === "send" || a === "ask" || a === "chat") { afterSend = true; continue; }
      if (afterSend && !a.startsWith("-") && !fv.has(a)) { message = a; break; }
    }
  }
  if (!message && !process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    message = Buffer.concat(chunks).toString().trim();
  }
  if (!message) {
    console.error("❌ No message provided");
    console.error("   Usage: wab send \"message\"");
    console.error("          wab send -a doubao \"message\"");
    console.error("          echo \"message\" | wab send");
    process.exit(1);
  }

  // Pre-flight check
  try {
    const h = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    const hd = await h.json();
    if (!hd.ok) { console.error("❌ Server error"); process.exit(1); }
    const extensionOk = !!hd.extensionConnected;
    const browserOk = !!hd.backends?.browser?.connected;
    if (backend === "browser" && !browserOk) {
      console.error("❌ Browser backend is not connected.");
      console.error("   Start it with: wab server --browser");
      process.exit(1);
    }
    if (backend === "extension" && !extensionOk) {
      console.error("❌ Extension not connected. Open an AI agent page first.");
      console.error("   Check: wab health");
      process.exit(1);
    }
    if (!backend && !extensionOk && !browserOk) {
      console.error("❌ No backend connected. Open an AI agent page, or start with: wab server --browser");
      console.error("   Check: wab health");
      process.exit(1);
    }
  } catch {
    console.error(`❌ Server not reachable at ${url}`);
    console.error("   Start it with: wab server");
    process.exit(1);
  }

  // Build A2A JSON-RPC payload with optional agent target in metadata
  const agentMeta = {};
  if (agent) agentMeta["x-target-agent"] = agent;
  if (backend) agentMeta["x-backend"] = backend;
  const metadata = Object.keys(agentMeta).length ? agentMeta : undefined;

  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "SendMessage",
    params: {
      message: {
        messageId: crypto.randomUUID(),
        contextId,
        taskId,
        role: "ROLE_USER",
        parts: [{ text: message, mediaType: "text/plain" }],
        metadata,
      },
      metadata,
    },
  };

  try {
    const resp = await fetch(`${url}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);

    const rpc = await resp.json();

    if (rpc.error) {
      if (jsonMode) console.log(JSON.stringify(rpc, null, 2));
      else console.error(`❌ RPC error ${rpc.error.code}: ${rpc.error.message}`);
      process.exit(1);
    }

    const rawResult = rpc.result;
    const task = rawResult?.task || rawResult;

    if (jsonMode) { console.log(JSON.stringify(rawResult, null, 2)); return; }

    const status = task.status;
    const state = status?.state;
    if (state === "TASK_STATE_FAILED" || state === 4) {
      const errParts = status.message?.parts || [];
      const errText = errParts.map((p) => p.text || "").filter(Boolean).join("\n");
      console.error(errText || "Task failed (no details)");
      process.exit(1);
    }

    const texts = [];
    if (task.artifacts) {
      for (const art of task.artifacts) {
        for (const part of art.parts || []) {
          const text = part.text || part.content?.value || part.content?.text || "";
          if (text) texts.push(text);
          else if (part.data || part.file) {
            texts.push(`[file: ${part.mediaType || "binary"}]`);
          }
        }
      }
    }

    if (texts.length > 0) console.log(texts.join("\n"));
    else { console.error("⚠️ No response text"); process.exit(1); }
  } catch (e) {
    if (e.name === "TimeoutError") {
      console.error(`❌ Timeout after ${timeout / 1000}s`);
    } else {
      console.error(`❌ ${e.message}`);
    }
    process.exit(1);
  }
}

// ── acp (stdio) ──

async function cmdAcp() {
  const entry = join(root, "server", "acp-stdio.ts");
  if (!existsSync(entry)) {
    console.error("❌ Cannot find server/acp-stdio.ts");
    process.exit(1);
  }

  const backend = getFlag("--backend", "-b") || "extension";
  if (backend !== "extension" && backend !== "browser") {
    console.error(`❌ Unknown backend "${backend}". Available: extension, browser`);
    process.exit(1);
  }

  const env = {
    ...process.env,
    WAB_ACP_BACKEND: backend,
    WAB_SERVER: getServerUrl(),
  };
  const cdp = cdpUrl();
  if (cdp) env.CDP_URL = cdp;

  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    env, stdio: "inherit", cwd: root,
  });
  child.on("exit", (code) => process.exit(code ?? 1));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

// ── login ──

async function cmdLogin() {
  const entry = join(root, "server", "browser-login.ts");
  if (!existsSync(entry)) {
    console.error("❌ Cannot find server/browser-login.ts");
    process.exit(1);
  }

  const fv = flagValues();
  let agent = getFlag("--agent", "-a");
  if (!agent) {
    let after = false;
    for (const a of args) {
      if (a === "login") { after = true; continue; }
      if (after && !a.startsWith("-") && !fv.has(a)) { agent = a; break; }
    }
  }
  if (agent && !KNOWN_AGENTS.includes(agent)) {
    console.error(`❌ Unknown agent "${agent}". Available: ${KNOWN_AGENTS.join(", ")}`);
    process.exit(1);
  }

  const env = { ...process.env, WAB_LOGIN_AGENT: agent || "" };
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    env, stdio: "inherit", cwd: root,
  });
  child.on("exit", (code) => process.exit(code ?? 1));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

// ── pack ──

async function cmdPack() {
  const extDir = join(root, "extension");
  const outFile = join(root, "web-agent-bridge-extension.zip");
  console.log("📦 Packaging extension...");
  const child = spawn("zip", ["-r", outFile, ".", "-x", "*.ts", "tsconfig.json", "*.map"], {
    cwd: extDir, stdio: "inherit",
  });
  child.on("exit", (code) => {
    if (code === 0) console.log(`✓ ${outFile}`);
    else process.exit(code ?? 1);
  });
}

// ── publish ──

async function cmdPublish() {
  const dryRun = hasFlag("--dry-run", "-n");

  // 1. Type check
  console.log("🔍 Type checking...");
  const tsc = spawn("npx", ["tsc", "--noEmit"], { cwd: root, stdio: "inherit" });
  await new Promise((resolve, reject) => {
    tsc.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`tsc failed (${code})`)));
  });

  // 2. Pack extension
  console.log("\n📦 Packing extension ZIP...");
  await cmdPack();

  // 3. npm publish
  console.log("\n📤 Publishing to npm...");
  const pubArgs = ["publish", "--access", "public"];
  if (dryRun) pubArgs.push("--dry-run");
  const pub = spawn("npm", pubArgs, { cwd: root, stdio: "inherit" });
  pub.on("exit", (code) => {
    if (code === 0) {
      console.log(`\n✅ Published web-agent-bridge@${VERSION}`);
    } else {
      console.error("\n❌ Publish failed");
      process.exit(code ?? 1);
    }
  });
}

// ── Help ──

function showHelp() {
  console.log(`
  wab — Web Agent Bridge CLI  v${VERSION}

  Usage:
    wab <command> [options]

  Commands:
    server              Start the local A2A server
    send <message>      Send a message and print the AI response
    acp                 Speak ACP on stdin/stdout (for editors)
    cdp                 Restart Dia with remote debugging (reuse Doubao login)
    login [agent]       Open a browser to log in (Playwright profile)
    agent               Show the Agent Card (skills & capabilities)
    health              Check server & extension connection status
    pack                Package extension as ZIP for distribution
    publish [--dry-run] Type-check, pack, and publish to npm

  Options (send):
    -a, --agent <name>  Target agent: doubao | chatgpt | gemini | workbuddy | perplexity | kimi | qianwen
    -b, --backend <name>  Backend: extension | browser (default: auto)
    -m, --message <msg> Message text (alternative to positional arg)
    -s, --server <url>  Server URL (default: http://127.0.0.1:3000)
    -c, --context <id>  Context ID for multi-turn conversations
    -t, --task <id>     Continue an existing task
    -T, --timeout <sec> Timeout in seconds (default: 180)
    -j, --json          Output raw JSON

  Options (server):
    -p, --port <port>   Port number (default: 3000)
    --browser           Also start the Playwright backend
    --browser-only      Playwright only (no Chrome extension WebSocket)
    --cdp [url|auto]    Attach Playwright to a running browser (default: auto-discover)
    --acp               Also serve ACP at /acp

  Options (acp):
    -b, --backend <name>  extension (proxy to wab server) | browser (local Playwright)
    --cdp [url]         CDP endpoint when --backend browser
    -s, --server <url>  A2A server used by the extension backend

  Examples:
    wab server                              # Extension backend
    wab server --browser --acp             # Extension + Playwright + ACP
    wab send "1+1等于几？"                   # Auto-detect agent
    wab cdp                                 # Restart Dia with CDP (keep Doubao login)
    wab server --browser --cdp --acp        # Attach to that Dia + ACP
    wab send -b browser -a doubao "你好"    # Drive the open Doubao tab
    wab login doubao                        # Alt: save cookies for a private Chromium
    wab acp                                 # ACP stdio, via running server
    wab acp -b browser                      # ACP stdio, local Playwright

  Environment:
    WAB_SERVER              Default server URL
    PORT                    Default server port
    WAB_USER_DATA_DIR       Playwright profile directory
    WAB_HEADLESS=0          Show the Playwright window

  Advanced A2A client:
    agentalk send http://127.0.0.1:3000 -m "hello"

  Docs: https://github.com/IchenDEV/web-agent-bridge
`);
}

// ── Main ──

switch (command) {
  case "server": case "start":
    cmdServer(); break;
  case "send": case "ask": case "chat":
    cmdSend(); break;
  case "acp":
    cmdAcp(); break;
  case "cdp": case "attach":
    cmdCdp(); break;
  case "login":
    cmdLogin(); break;
  case "agent": case "card": case "info":
    cmdAgent(); break;
  case "health": case "status":
    cmdHealth(); break;
  case "pack":
    cmdPack(); break;
  case "publish":
    cmdPublish(); break;
  case "--help": case "-h": case "help": case undefined:
    showHelp(); break;
  case "--version": case "-V":
    console.log(`wab ${VERSION}`); break;
  default:
    args.unshift("send");
    cmdSend(); break;
}
