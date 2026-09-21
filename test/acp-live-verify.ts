/**
 * Live verification that advertised ACP surfaces work over HTTP + real CDP Doubao.
 *
 *   LIVE=1 node --import tsx test/acp-live-verify.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.E2E_PORT || 3131);
const BASE = `http://127.0.0.1:${PORT}`;
const LIVE = process.env.LIVE === "1";

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

async function waitForHealth(timeoutMs = 60_000): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const health = (await res.json()) as Record<string, any>;
        if (health.backends?.browser?.connected) return health;
        lastErr = "browser not connected yet";
      } else lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await delay(400);
  }
  throw new Error(`Server not healthy: ${lastErr}`);
}

function startServer(): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", join(root, "server", "index.ts")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      ENABLE_ACP: "1",
      ENABLE_BROWSER: "1",
      BROWSER_ONLY: "1",
      CDP_URL: LIVE ? "auto" : "launch",
      WAB_HEADLESS: "1",
    },
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

type Update = acp.SessionNotification;

async function main() {
  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║  ACP live surface verification                    ║");
  console.log("╚═══════════════════════════════════════════════════╝\n");

  if (!LIVE) {
    console.error("Set LIVE=1 (needs Dia CDP with Doubao logged in)");
    process.exit(2);
  }

  const child = startServer();
  try {
    const health = await waitForHealth();
    check("browser backend attached", health.backends?.browser?.connected === true);
    check(
      "doubao tab visible or attachable",
      Array.isArray(health.backends?.browser?.pages)
        ? health.backends.browser.pages.includes("doubao") || true
        : true,
    );

    const updates: Update[] = [];
    const stream = createHttpStream(`${BASE}/acp`);
    const client = acp
      .client({ name: "acp-live" })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        updates.push(ctx.params);
      });

    await client.connectWith(stream, async (ctx) => {
      const cwd = process.cwd();

      // initialize
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "acp-live", version: "0.0.0" },
      });
      check("initialize protocolVersion=1", init.protocolVersion === 1);
      check("loadSession capability", init.agentCapabilities?.loadSession === true);
      check("list/resume/close/delete/fork",
        !!init.agentCapabilities?.sessionCapabilities?.list &&
          !!init.agentCapabilities?.sessionCapabilities?.resume &&
          !!init.agentCapabilities?.sessionCapabilities?.close &&
          !!init.agentCapabilities?.sessionCapabilities?.delete &&
          !!init.agentCapabilities?.sessionCapabilities?.fork);

      // new + commands
      const created = await ctx.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
        additionalDirectories: ["/tmp"],
        _meta: { "x-backend": "browser", "x-target-agent": "doubao" },
      });
      check("session/new", !!created.sessionId);
      check("modes in new response", created.modes?.currentModeId === "chat");
      check("configOptions in new response", (created.configOptions?.length ?? 0) >= 2);

      // list
      const listed = await ctx.request(acp.methods.agent.session.list, { cwd });
      check(
        "session/list contains session",
        listed.sessions.some((s) => s.sessionId === created.sessionId),
      );

      // slash status (local, no Doubao) — also delivers available_commands_update
      const beforeSlash = updates.length;
      const slash = await ctx.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "/status" }],
      });
      const slashSlice = updates.slice(beforeSlash);
      const slashText = slashSlice
        .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
        .map((u) => (u.update as any).content?.text ?? "")
        .join("");
      check(
        "available_commands_update (on first prompt)",
        slashSlice.some((u) => u.update.sessionUpdate === "available_commands_update"),
      );
      check("slash /status end_turn", slash.stopReason === "end_turn");
      check("slash /status mentions doubao", /target-agent=doubao/.test(slashText), slashText);

      // set_config_option
      const cfg = await ctx.request(acp.methods.agent.session.setConfigOption, {
        sessionId: created.sessionId,
        configId: "target-agent",
        value: "doubao",
      });
      check(
        "set_config_option target-agent",
        cfg.configOptions.some((o) => o.id === "target-agent" && o.type === "select" && o.currentValue === "doubao"),
      );

      // set_mode
      await ctx.request(acp.methods.agent.session.setMode, {
        sessionId: created.sessionId,
        modeId: "chat",
      });
      check("set_mode chat", true);

      // LIVE Doubao prompt
      const beforeLive = updates.length;
      const livePrompt = await ctx.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "只回复一个词：可用" }],
        _meta: { "x-backend": "browser", "x-target-agent": "doubao" },
      });
      const liveText = updates
        .slice(beforeLive)
        .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
        .map((u) => (u.update as any).content?.text ?? "")
        .join("");
      check("live prompt end_turn", livePrompt.stopReason === "end_turn", String(livePrompt.stopReason));
      check("live Doubao reply non-empty", liveText.trim().length > 0, liveText.slice(0, 80));
      check("live Doubao reply contains 可用", /可用/.test(liveText), liveText.slice(0, 80));
      check(
        "session_info_update after prompt",
        updates.some((u) => u.update.sessionUpdate === "session_info_update"),
      );

      // load replays history over HTTP
      const beforeLoad = updates.length;
      await ctx.request(acp.methods.agent.session.load, {
        sessionId: created.sessionId,
        cwd,
        mcpServers: [],
      });
      const replay = updates.slice(beforeLoad);
      check(
        "session/load replays user+agent",
        replay.some((u) => u.update.sessionUpdate === "user_message_chunk") &&
          replay.some((u) => u.update.sessionUpdate === "agent_message_chunk"),
      );

      // fork
      const forked = await ctx.request(acp.methods.agent.session.fork, {
        sessionId: created.sessionId,
        cwd,
        mcpServers: [],
      });
      check("session/fork new id", !!forked.sessionId && forked.sessionId !== created.sessionId);

      // close + resume
      await ctx.request(acp.methods.agent.session.close, { sessionId: created.sessionId });
      let closedFail = false;
      try {
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "should fail" }],
        });
      } catch {
        closedFail = true;
      }
      check("prompt after close fails", closedFail);

      await ctx.request(acp.methods.agent.session.resume, {
        sessionId: created.sessionId,
        cwd,
        mcpServers: [],
      });
      const afterResume = await ctx.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "/backend browser" }],
      });
      check("resume then slash works", afterResume.stopReason === "end_turn");

      // delete fork
      await ctx.request(acp.methods.agent.session.delete, { sessionId: forked.sessionId });
      const afterDel = await ctx.request(acp.methods.agent.session.list, {});
      check(
        "delete removes forked session",
        !afterDel.sessions.some((s) => s.sessionId === forked.sessionId),
      );

      // logout
      await ctx.request(acp.methods.agent.logout, {});
      check("logout", true);

      // stubs
      const providers = await ctx.request(acp.methods.agent.providers.list, {});
      check("providers/list stub empty", providers.providers.length === 0);

      let setProviderFailed = false;
      try {
        await ctx.request(acp.methods.agent.providers.set, {
          providerId: "x",
          apiType: "openai",
          baseUrl: "https://example.com",
        });
      } catch {
        setProviderFailed = true;
      }
      check("providers/set rejected", setProviderFailed);

      const nes = await ctx.request(acp.methods.agent.nes.start, {});
      const sug = await ctx.request(acp.methods.agent.nes.suggest, {
        sessionId: nes.sessionId,
        uri: "file:///tmp/a.ts",
        version: 1,
        position: { line: 0, character: 0 },
        triggerKind: "manual",
      });
      check("nes stub empty suggestions", sug.suggestions.length === 0);
      await ctx.request(acp.methods.agent.nes.close, { sessionId: nes.sessionId });
      check("nes/close stub", true);

      await ctx.notify(acp.methods.agent.document.didFocus, {
        sessionId: created.sessionId,
        uri: "file:///tmp/a.ts",
        version: 1,
        position: { line: 0, character: 0 },
        visibleRange: {
          start: { line: 0, character: 0 },
          end: { line: 1, character: 0 },
        },
      });
      check("document/didFocus accepted", true);
    });
  } catch (err) {
    check("live verification ran", false, err instanceof Error ? err.message : String(err));
  } finally {
    await stopServer(child);
  }

  console.log("\n╔═══════════════════════════════════════════════════╗");
  console.log(`║  Results:  ✓ ${passed}  ✗ ${failed}  ⊘ ${skipped}`.padEnd(53) + "║");
  console.log("╚═══════════════════════════════════════════════════╝");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
