/**
 * End-to-end verification for ACP + dual backends.
 *
 * Starts a temporary server, checks health / Agent Card / ACP HTTP,
 * and optionally exercises a live Playwright prompt.
 *
 *   npm run test:e2e:acp
 *   LIVE=1 npm run test:e2e:acp          # real page prompt (needs login)
 *   LIVE=1 AGENT=chatgpt npm run test:e2e:acp
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.E2E_PORT || 3127);
const BASE = `http://127.0.0.1:${PORT}`;
const LIVE = process.env.LIVE === "1";
const AGENT = process.env.AGENT || "doubao";

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(name: string, reason: string) {
  skipped++;
  console.log(`  ⊘ ${name} (${reason})`);
}

async function waitForHealth(
  timeoutMs = 30_000,
  predicate?: (health: Record<string, any>) => boolean,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  let lastHealth: Record<string, any> | null = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        lastHealth = (await res.json()) as Record<string, any>;
        if (!predicate || predicate(lastHealth)) return lastHealth;
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await delay(400);
  }
  if (lastHealth) return lastHealth;
  throw new Error(`Server did not become healthy: ${lastErr}`);
}

function startServer(env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", join(root, "server", "index.ts")], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (buf) => process.stderr.write(`[server] ${buf}`));
  child.stderr?.on("data", (buf) => process.stderr.write(`[server] ${buf}`));
  return child;
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(5000).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
}

async function runAcpHttpSession(expectPrompt: boolean): Promise<void> {
  const updates: string[] = [];
  const stream = createHttpStream(`${BASE}/acp`);
  const client = acp
    .client({ name: "e2e-acp" })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const update = ctx.params.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        updates.push(update.content.text);
      }
    });

  await client.connectWith(stream, async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "e2e-acp", version: "0.0.0" },
    });
    check("ACP HTTP initialize negotiates v1", init.protocolVersion === 1);
    check("ACP HTTP agentInfo present", init.agentInfo?.name === "web-agent-bridge");

    const session = await ctx.request(acp.methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { "x-backend": "browser", "x-target-agent": AGENT },
    });
    check("ACP HTTP session/new returns sessionId", !!session.sessionId);

    if (!expectPrompt) {
      skip("ACP HTTP session/prompt", "live prompt disabled (set LIVE=1)");
      return;
    }

    const prompt = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "1+1等于几？请只回答数字。" }],
      _meta: { "x-backend": "browser", "x-target-agent": AGENT },
    });
    check("ACP HTTP prompt ends with end_turn", prompt.stopReason === "end_turn", String(prompt.stopReason));
    const reply = updates.join("");
    check("ACP HTTP streamed a non-empty reply", reply.length > 0, reply.slice(0, 80));
    check("ACP HTTP reply looks like the math answer", /2/.test(reply), reply.slice(0, 80));
  });
}

async function main() {
  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║  E2E — ACP + Browser Backend                      ║");
  console.log("╚═══════════════════════════════════════════════════╝\n");

  // ── Phase A: extension-mode server + ACP (no browser) ──
  console.log("§A  Server (extension backend + ACP)");
  let child = startServer({
    PORT: String(PORT),
    ENABLE_ACP: "1",
    ENABLE_BROWSER: "",
    BROWSER_ONLY: "",
  });

  try {
    const health = await waitForHealth();
    check("GET /health ok", health.ok === true);
    check("extension backend registered", health.backends?.extension != null);
    check("extension starts disconnected", health.backends?.extension?.connected === false);
    check("browser not registered by default", health.backends?.browser == null);

    const cardRes = await fetch(`${BASE}/.well-known/agent-card.json`);
    const card = (await cardRes.json()) as { name?: string; skills?: unknown[] };
    check("Agent Card reachable", cardRes.ok && card.name === "Web Agent Bridge");
    check("Agent Card lists skills", Array.isArray(card.skills) && (card.skills?.length ?? 0) > 0);

    console.log("\n§A2 ACP over HTTP (no live page)");
    await runAcpHttpSession(false);

    const a2a = await fetch(`${BASE}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          message: {
            messageId: crypto.randomUUID(),
            contextId: crypto.randomUUID(),
            taskId: "",
            role: "ROLE_USER",
            parts: [{ text: "ping", mediaType: "text/plain" }],
          },
        },
      }),
    });
    const a2aJson = (await a2a.json()) as { result?: { task?: { status?: { state?: string } } }; error?: unknown };
    const state = a2aJson.result?.task?.status?.state;
    check(
      "A2A SendMessage returns a terminal task without extension",
      state === "TASK_STATE_FAILED" || state === "TASK_STATE_COMPLETED" || !!a2aJson.error,
      String(state),
    );
  } finally {
    await stopServer(child);
  }

  // ── Phase B: browser-only + ACP ──
  console.log("\n§B  Server (browser-only + ACP)");
  child = startServer({
    PORT: String(PORT),
    ENABLE_ACP: "1",
    ENABLE_BROWSER: "1",
    BROWSER_ONLY: "1",
    WAB_HEADLESS: "1",
    // LIVE attaches to the user's Dia/Chrome; otherwise launch a private Chromium.
    CDP_URL: LIVE ? "auto" : "launch",
  });

  try {
    const health = await waitForHealth(60_000, (h) => h.backends?.browser?.connected === true);
    check("GET /health ok (browser-only)", health.ok === true);
    check("extension not registered in browser-only", health.backends?.extension == null);
    check("browser backend connected", health.backends?.browser?.connected === true);

    console.log(`\n§B2 ACP over HTTP${LIVE ? " + live Playwright prompt" : ""}`);
    await runAcpHttpSession(LIVE);
  } catch (err) {
    check("browser-only server started", false, err instanceof Error ? err.message : String(err));
  } finally {
    await stopServer(child);
  }

  // ── Phase C: Playwright smoke (no AI login) ──
  console.log("\n§C  Playwright smoke");
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    const title = await page.title();
    check("Playwright can launch Chromium", true);
    check("Playwright can open a public page", /example/i.test(title), title);
    await browser.close();

    const { BrowserBackend } = await import("../server/browser-backend.js");
    const backend = new BrowserBackend();
    // Force a private Chromium so smoke never attaches to the user's Dia.
    await backend.connect("launch");
    check("BrowserBackend.connect succeeds", backend.connected);
    backend.close();
    check("BrowserBackend.close succeeds", !backend.connected);
  } catch (err) {
    check("Playwright smoke", false, err instanceof Error ? err.message : String(err));
  }

  console.log("\n╔═══════════════════════════════════════════════════╗");
  console.log(`║  Results:  ✓ ${passed}  ✗ ${failed}  ⊘ ${skipped}`.padEnd(53) + "║");
  if (!LIVE) {
    console.log("║  Tip: LIVE=1 npm run test:e2e:acp  (needs login)  ║");
  }
  console.log("╚═══════════════════════════════════════════════════╝");
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error("\n✗ E2E crashed:", err);
  process.exit(1);
});
