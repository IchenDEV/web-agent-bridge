#!/usr/bin/env node

/**
 * Web Agent Bridge CLI
 *
 * Usage:
 *   web-agent-bridge server [-p port]          Start the A2A server
 *   web-agent-bridge send   [-s url] "message" Send a message and print the response
 *   web-agent-bridge agent  [-s url]           Show the Agent Card
 *   web-agent-bridge health [-s url]           Check server & extension status
 *
 * AI agents can call `send` directly and parse stdout — no HTTP needed.
 */

import { execSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const DEFAULT_SERVER = "http://127.0.0.1:3000";

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
  return getFlag("--server", "-s") || process.env.WEB_AGENT_BRIDGE_URL || DEFAULT_SERVER;
}

const jsonMode = hasFlag("--json", "-j");

// ── Commands ──

async function cmdServer() {
  const port = getFlag("--port", "-p") || process.env.PORT || "3000";
  const serverEntry = join(root, "server", "index.ts");

  if (!existsSync(serverEntry)) {
    console.error("❌ Cannot find server/index.ts");
    process.exit(1);
  }

  console.log(`
  ╔═══════════════════════════════════════════╗
  ║        Web Agent Bridge  v0.3.0          ║
  ╠═══════════════════════════════════════════╣
  ║  A2A Server:  http://127.0.0.1:${String(port).padEnd(5)}    ║
  ║  Agent Card:  /.well-known/agent-card.json║
  ║  WebSocket:   ws://127.0.0.1:${String(port).padEnd(5)}/ws  ║
  ╚═══════════════════════════════════════════╝
`);

  const env = { ...process.env, PORT: port };
  const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    env,
    stdio: "inherit",
    cwd: root,
  });
  child.on("exit", (code) => process.exit(code ?? 1));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

async function cmdAgent() {
  const url = getServerUrl();
  try {
    const resp = await fetch(`${url}/.well-known/agent-card.json`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const card = await resp.json();

    if (jsonMode) {
      console.log(JSON.stringify(card, null, 2));
      return;
    }

    console.log(`\n🤖 ${card.name}  v${card.version}`);
    console.log(`   ${card.description}\n`);

    if (card.capabilities) {
      const caps = [];
      if (card.capabilities.streaming) caps.push("streaming");
      if (card.capabilities.pushNotifications) caps.push("push-notifications");
      if (caps.length) console.log(`   Capabilities: ${caps.join(", ")}`);
    }

    if (card.skills?.length) {
      console.log(`\n   Skills:`);
      for (const s of card.skills) {
        console.log(`     • ${s.name} (${s.id})`);
        if (s.description) console.log(`       ${s.description}`);
        if (s.tags?.length) console.log(`       tags: ${s.tags.join(", ")}`);
      }
    }

    if (card.supportedInterfaces?.length) {
      console.log(`\n   Interfaces:`);
      for (const iface of card.supportedInterfaces) {
        console.log(`     ${iface.protocolBinding} → ${iface.url}`);
      }
    }
    console.log();
  } catch (e) {
    console.error(`❌ Cannot reach ${url}: ${e.message}`);
    process.exit(1);
  }
}

async function cmdHealth() {
  const url = getServerUrl();
  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();

    if (jsonMode) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const serverOk = data.ok ? "✅" : "❌";
    const extOk = data.extensionConnected ? "✅" : "❌";
    console.log(`\n  Server:    ${serverOk} ${data.ok ? "running" : "error"}`);
    console.log(`  Extension: ${extOk} ${data.extensionConnected ? "connected" : "not connected"}`);
    console.log();

    if (!data.extensionConnected) {
      console.log("  💡 Make sure:");
      console.log("     1. Chrome extension is installed and enabled");
      console.log("     2. An AI agent page is open (doubao.com, workbuddy.cn)");
      console.log();
    }
  } catch (e) {
    console.error(`❌ Server not reachable at ${url}: ${e.message}`);
    console.error("   Start the server with: web-agent-bridge server");
    process.exit(1);
  }
}

async function cmdSend() {
  const url = getServerUrl();
  const contextId = getFlag("--context", "-c") || crypto.randomUUID();
  const taskId = getFlag("--task", "-t") || "";
  const timeout = parseInt(getFlag("--timeout", "-T") || "180", 10) * 1000;

  // Collect message text: -m "text" or positional arg after "send"
  let message = getFlag("--message", "-m");
  if (!message) {
    // Find first positional arg after "send" that doesn't start with "-"
    let afterSend = false;
    for (const a of args) {
      if (a === "send") {
        afterSend = true;
        continue;
      }
      if (afterSend && !a.startsWith("-") && a !== getFlag("--server", "-s") && a !== getFlag("--context", "-c") && a !== getFlag("--task", "-t") && a !== getFlag("--timeout", "-T")) {
        message = a;
        break;
      }
    }
  }

  if (!message) {
    // Try stdin if piped
    if (!process.stdin.isTTY) {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      message = Buffer.concat(chunks).toString().trim();
    }
  }

  if (!message) {
    console.error("❌ No message provided");
    console.error("   Usage: web-agent-bridge send \"your message here\"");
    console.error("          web-agent-bridge send -m \"your message\"");
    console.error("          echo \"your message\" | web-agent-bridge send");
    process.exit(1);
  }

  // Pre-flight: check extension is connected
  try {
    const healthResp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    const healthData = await healthResp.json();
    if (!healthData.ok) {
      console.error("❌ Server error");
      process.exit(1);
    }
    if (!healthData.extensionConnected) {
      console.error("❌ Browser extension is not connected to the server.");
      console.error("   1. Make sure the extension is installed and enabled");
      console.error("   2. Open an AI agent page (doubao.com or workbuddy.cn)");
      console.error("   3. Check: web-agent-bridge health");
      process.exit(1);
    }
  } catch (e) {
    console.error(`❌ Server not reachable at ${url}`);
    console.error("   Start the server with: web-agent-bridge server");
    process.exit(1);
  }

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
    },
  };

  try {
    const resp = await fetch(`${url}/a2a`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "A2A-Version": "1.0",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);

    const rpc = await resp.json();

    if (rpc.error) {
      if (jsonMode) {
        console.log(JSON.stringify(rpc, null, 2));
      } else {
        console.error(`❌ RPC error ${rpc.error.code}: ${rpc.error.message}`);
      }
      process.exit(1);
    }

    const rawResult = rpc.result;
    // The SDK wraps the task in a "task" field: { task: { ... } }
    const task = rawResult?.task || rawResult;

    if (jsonMode) {
      console.log(JSON.stringify(rawResult, null, 2));
      return;
    }

    // Check for failure first
    const status = task.status;
    const state = status?.state;
    if (state === "TASK_STATE_FAILED" || state === 4) {
      const errParts = status.message?.parts || [];
      const errText = errParts.map((p) => p.text || "").filter(Boolean).join("\n");
      console.error(errText || "Task failed (no details)");
      process.exit(1);
    }

    // Extract response text from artifacts
    const texts = [];
    if (task.artifacts) {
      for (const artifact of task.artifacts) {
        for (const part of artifact.parts || []) {
          // A2A SDK JSON-RPC returns text in part.text (not part.content.$case)
          const text = part.text || part.content?.value || part.content?.text || "";
          if (text) texts.push(text);
          else if (part.data || part.file) {
            texts.push(`[file: ${part.mediaType || part.data?.mimeType || "binary"}]`);
          }
        }
      }
    }

    if (texts.length > 0) {
      // Plain text output — ideal for AI consumption
      console.log(texts.join("\n"));
    } else {
      console.error("⚠️ Task completed but no response text found");
      process.exit(1);
    }
  } catch (e) {
    if (e.name === "TimeoutError") {
      console.error(`❌ Timeout after ${timeout / 1000}s — the AI agent may be slow or disconnected`);
    } else {
      console.error(`❌ ${e.message}`);
    }
    process.exit(1);
  }
}

// ── Help ──

function showHelp() {
  console.log(`
  Web Agent Bridge CLI — call online AI agents via A2A protocol

  Usage:
    web-agent-bridge <command> [options]

  Commands:
    server              Start the local A2A server
    send <message>      Send a message and print the AI response
    agent               Show the Agent Card (capabilities & skills)
    health              Check server & extension connection status

  Options (send):
    -m, --message       Message text (alternative to positional arg)
    -s, --server <url>  Server URL (default: http://127.0.0.1:3000)
    -c, --context <id>  Context ID for multi-turn conversations
    -t, --task <id>     Continue an existing task
    -T, --timeout <sec> Timeout in seconds (default: 180)
    -j, --json          Output raw JSON (for programmatic use)

  Options (server):
    -p, --port <port>   Port number (default: 3000)

  Options (agent / health):
    -s, --server <url>  Server URL (default: http://127.0.0.1:3000)
    -j, --json          Output raw JSON

  Environment:
    WEB_AGENT_BRIDGE_URL    Default server URL
    PORT                    Default server port

  Examples:
    # Start server
    web-agent-bridge server

    # One-shot question (AI can parse stdout directly)
    web-agent-bridge send "1+1等于几？"

    # Pipe input
    echo "写一首诗" | web-agent-bridge send

    # Multi-turn conversation
    web-agent-bridge send -c ctx-123 "继续说"

    # JSON output for scripts
    web-agent-bridge send --json "hello"

    # Use with agentalk (advanced A2A client)
    agentalk send http://127.0.0.1:3000 -m "hello"

  Docs: https://github.com/IchenDEV/web-agent-bridge
`);
}

// ── Main ──

switch (command) {
  case "server":
  case "start":
    cmdServer();
    break;
  case "send":
  case "ask":
  case "chat":
    cmdSend();
    break;
  case "agent":
  case "card":
  case "info":
    cmdAgent();
    break;
  case "health":
  case "status":
    cmdHealth();
    break;
  case "--help":
  case "-h":
  case "help":
  case undefined:
    showHelp();
    break;
  case "--version":
  case "-V":
    console.log("web-agent-bridge 0.3.0");
    break;
  default:
    // If no subcommand, treat the entire args as a message to send
    // e.g. `web-agent-bridge "1+1=?"` works as shorthand for `send`
    args.unshift("send");
    cmdSend();
    break;
}
