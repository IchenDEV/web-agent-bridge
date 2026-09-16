#!/usr/bin/env node

/**
 * wab — Web Agent Bridge CLI
 *
 * Usage:
 *   wab server  [-p port]                    Start the A2A server
 *   wab send    [-a agent] "message"         Send a message, print response
 *   wab agent   [-s url]                     Show Agent Card
 *   wab health  [-s url]                     Check connection status
 *   wab pack                                 Package extension as ZIP
 *   wab publish [--dry-run]                  Publish to npm
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

const KNOWN_AGENTS = ["doubao", "workbuddy", "chatgpt", "gemini"];

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

  console.log(`
  ╔════════════════════════════════════════╗
  ║       Web Agent Bridge  v${VERSION.padEnd(8)}   ║
  ╠════════════════════════════════════════╣
  ║  A2A:   http://127.0.0.1:${String(port).padEnd(5)}      ║
  ║  WS:    ws://127.0.0.1:${String(port).padEnd(5)}/ws    ║
  ╚════════════════════════════════════════╝
`);

  const env = { ...process.env, PORT: port };
  const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    env, stdio: "inherit", cwd: root,
  });
  child.on("exit", (code) => process.exit(code ?? 1));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
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
  const contextId = getFlag("--context", "-c") || crypto.randomUUID();
  const taskId = getFlag("--task", "-t") || "";
  const timeout = parseInt(getFlag("--timeout", "-T") || "180", 10) * 1000;

  if (agent && !KNOWN_AGENTS.includes(agent)) {
    console.error(`❌ Unknown agent "${agent}". Available: ${KNOWN_AGENTS.join(", ")}`);
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
    if (!hd.extensionConnected) {
      console.error("❌ Extension not connected. Open an AI agent page first.");
      console.error("   Check: wab health");
      process.exit(1);
    }
  } catch {
    console.error(`❌ Server not reachable at ${url}`);
    console.error("   Start it with: wab server");
    process.exit(1);
  }

  // Build A2A JSON-RPC payload with optional agent target in metadata
  const metadata = agent ? { "x-target-agent": agent } : undefined;

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
    agent               Show the Agent Card (skills & capabilities)
    health              Check server & extension connection status
    pack                Package extension as ZIP for distribution
    publish [--dry-run] Type-check, pack, and publish to npm

  Options (send):
    -a, --agent <name>  Target agent: doubao | workbuddy (default: auto)
    -m, --message <msg> Message text (alternative to positional arg)
    -s, --server <url>  Server URL (default: http://127.0.0.1:3000)
    -c, --context <id>  Context ID for multi-turn conversations
    -t, --task <id>     Continue an existing task
    -T, --timeout <sec> Timeout in seconds (default: 180)
    -j, --json          Output raw JSON

  Options (server):
    -p, --port <port>   Port number (default: 3000)

  Environment:
    WAB_SERVER              Default server URL
    PORT                    Default server port

  Examples:
    wab server                              # Start A2A server
    wab send "1+1等于几？"                   # Auto-detect agent
    wab send -a doubao "帮我操作飞书"        # Target Doubao
    wab send -a workbuddy "写一份周报"       # Target WorkBuddy
    echo "写一首诗" | wab send              # Pipe input
    wab send --json "hello"                 # JSON output
    wab publish --dry-run                   # Test publish flow

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
