/**
 * ACP v1 protocol checks against an in-process agent and a fake backend.
 *
 * Run:  npx tsx test/acp-protocol-verify.ts
 *   or: npm run test:acp
 */

import * as acp from "@agentclientprotocol/sdk";
import { BackendRouter, type MessageBackend, type StreamChunk } from "../server/message-backend.js";
import { createWebAgentApp } from "../server/acp-agent.js";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

class FakeBackend implements MessageBackend {
  readonly name: string;
  connected: boolean;
  calls: Array<{ text: string; target?: string }> = [];
  chunks: StreamChunk[] = [{ text: "echo", done: true }];
  delayMs = 0;

  constructor(name: string, connected = true) {
    this.name = name;
    this.connected = connected;
  }

  async *sendAndStream(
    _taskId: string,
    text: string,
    _timeoutMs?: number,
    target?: string,
  ): AsyncGenerator<StreamChunk> {
    this.calls.push({ text, target });
    if (this.delayMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, this.delayMs);
        timer.unref();
      });
    }
    for (const chunk of this.chunks) yield chunk;
  }

  async sendAndWait(taskId: string, text: string, timeoutMs?: number, target?: string): Promise<string> {
    let finalText = "";
    for await (const chunk of this.sendAndStream(taskId, text, timeoutMs, target)) {
      if (chunk.done) finalText = chunk.text;
    }
    return finalText;
  }

  close(): void {
    this.connected = false;
  }
}

function textsOf(updates: acp.SessionNotification[]): string[] {
  const out: string[] = [];
  for (const note of updates) {
    const update = note.update;
    if (
      (update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "user_message_chunk") &&
      update.content.type === "text"
    ) {
      out.push(`${update.sessionUpdate}:${update.content.text}`);
    }
  }
  return out;
}

async function withClient<T>(
  backend: MessageBackend,
  op: (
    ctx: acp.ClientContext,
    updates: acp.SessionNotification[],
  ) => Promise<T>,
): Promise<T> {
  const updates: acp.SessionNotification[] = [];
  const agent = createWebAgentApp(backend);
  const client = acp
    .client({ name: "acp-verify" })
    .onNotification(acp.methods.client.session.update, (c) => {
      updates.push(c.params);
    });
  return client.connectWith(agent, async (ctx) => op(ctx, updates));
}

async function main() {
  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║  ACP v1 — Web Agent Bridge verification           ║");
  console.log("╚═══════════════════════════════════════════════════╝\n");

  // ── Router fallback ──
  console.log("§1  BackendRouter");
  const extension = new FakeBackend("extension", false);
  const browser = new FakeBackend("browser", true);
  browser.chunks = [{ text: "from-browser", done: true }];
  const router = new BackendRouter("extension");
  router.register(extension);
  router.register(browser);

  check("router.connected when any backend is up", router.connected);
  const routed = await router.sendAndWait("t1", "hi");
  check("disconnected default falls back to browser", routed === "from-browser");
  extension.connected = true;
  extension.chunks = [{ text: "from-extension", done: true }];
  const explicit = await router.sendAndWaitVia("browser", "t2", "hi");
  check("explicit backend bypasses the default", explicit === "from-browser" && browser.calls.length === 2);
  const status = router.status();
  check("status reports both backends", status.extension?.connected === true && status.browser?.connected === true);
  console.log();

  // ── initialize capabilities ──
  console.log("§2  initialize capabilities");
  await withClient(new FakeBackend("extension"), async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "acp-verify", version: "0.0.0" },
    });
    check("protocolVersion is 1", init.protocolVersion === 1);
    check("loadSession advertised", init.agentCapabilities?.loadSession === true);
    check("session list/delete/resume/close/fork advertised",
      !!init.agentCapabilities?.sessionCapabilities?.list &&
        !!init.agentCapabilities?.sessionCapabilities?.delete &&
        !!init.agentCapabilities?.sessionCapabilities?.resume &&
        !!init.agentCapabilities?.sessionCapabilities?.close &&
        !!init.agentCapabilities?.sessionCapabilities?.fork);
    check("additionalDirectories advertised", !!init.agentCapabilities?.sessionCapabilities?.additionalDirectories);
    check("auth.logout advertised", !!init.agentCapabilities?.auth?.logout);
    check("providers NOT advertised", init.agentCapabilities?.providers == null);
    check("nes NOT advertised", init.agentCapabilities?.nes == null);
    check("authMethods empty", Array.isArray(init.authMethods) && init.authMethods.length === 0);
    check("agentInfo.name is web-agent-bridge", init.agentInfo?.name === "web-agent-bridge");
  });
  console.log();

  // ── session lifecycle ──
  console.log("§3  session lifecycle (new/list/prompt/load/resume/close/fork/delete)");
  const fake = new FakeBackend("extension", true);
  fake.chunks = [
    { text: "hel", done: false },
    { text: "lo", done: false },
    { text: "hello", done: true },
  ];

  await withClient(fake, async (ctx, updates) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1 });
    const cwd = process.cwd();
    const session = await ctx.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
      additionalDirectories: ["/tmp"],
      _meta: { "x-target-agent": "doubao", "x-backend": "extension" },
    });
    check("session/new returns sessionId", !!session.sessionId);
    check("session/new returns modes", session.modes?.currentModeId === "chat");
    check("session/new returns configOptions", (session.configOptions?.length ?? 0) >= 2);

    const listed = await ctx.request(acp.methods.agent.session.list, { cwd });
    check("session/list includes new session", listed.sessions.some((s) => s.sessionId === session.sessionId));
    check(
      "session/list reports additionalDirectories",
      listed.sessions.find((s) => s.sessionId === session.sessionId)?.additionalDirectories?.[0] === "/tmp",
    );

    const prompt = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "ping" }],
      _meta: { "x-target-agent": "chatgpt" },
    });
    check("prompt stopReason is end_turn", prompt.stopReason === "end_turn");
    check(
      "available_commands_update delivered",
      updates.some((u) => u.update.sessionUpdate === "available_commands_update"),
    );
    check("prompt text reached the backend", fake.calls[0]?.text === "ping");
    check("prompt _meta target overrides session target", fake.calls[0]?.target === "chatgpt");
    const agentText = textsOf(updates)
      .filter((t) => t.startsWith("agent_message_chunk:"))
      .map((t) => t.slice("agent_message_chunk:".length))
      .join("");
    check(
      "user + agent chunks streamed",
      textsOf(updates).includes("user_message_chunk:ping") && agentText === "hello",
      agentText,
    );

    const beforeLoad = updates.length;
    await ctx.request(acp.methods.agent.session.load, {
      sessionId: session.sessionId,
      cwd,
      mcpServers: [],
    });
    const replayed = updates.slice(beforeLoad);
    check(
      "session/load replays history",
      replayed.some((u) => u.update.sessionUpdate === "user_message_chunk") &&
        replayed.some((u) => u.update.sessionUpdate === "agent_message_chunk"),
    );

    await ctx.request(acp.methods.agent.session.close, { sessionId: session.sessionId });
    let closedPromptFailed = false;
    try {
      await ctx.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "nope" }],
      });
    } catch {
      closedPromptFailed = true;
    }
    check("prompt on closed session fails", closedPromptFailed);

    await ctx.request(acp.methods.agent.session.resume, {
      sessionId: session.sessionId,
      cwd,
      mcpServers: [],
    });
    const afterResume = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/status" }],
    });
    check("session/resume reactivates session", afterResume.stopReason === "end_turn");
    check(
      "slash /status handled locally",
      textsOf(updates).some((t) => t.includes("target-agent=")),
    );
    check("slash /status did not hit backend again", fake.calls.length === 1);

    const forked = await ctx.request(acp.methods.agent.session.fork, {
      sessionId: session.sessionId,
      cwd,
      mcpServers: [],
    });
    check("session/fork returns new id", !!forked.sessionId && forked.sessionId !== session.sessionId);

    await ctx.request(acp.methods.agent.session.delete, { sessionId: forked.sessionId });
    const afterDelete = await ctx.request(acp.methods.agent.session.list, {});
    check(
      "session/delete removes from list",
      !afterDelete.sessions.some((s) => s.sessionId === forked.sessionId),
    );

    const mode = await ctx.request(acp.methods.agent.session.setMode, {
      sessionId: session.sessionId,
      modeId: "chat",
    });
    check("session/set_mode accepts chat", mode != null);

    const cfg = await ctx.request(acp.methods.agent.session.setConfigOption, {
      sessionId: session.sessionId,
      configId: "backend",
      value: "browser",
    });
    check(
      "session/set_config_option updates backend",
      cfg.configOptions.some((o) => o.id === "backend" && o.type === "select" && o.currentValue === "browser"),
    );

    await ctx.request(acp.methods.agent.logout, {});
    check("logout succeeds", true);

    const providers = await ctx.request(acp.methods.agent.providers.list, {});
    check("providers/list returns empty (stub)", providers.providers.length === 0);

    const nes = await ctx.request(acp.methods.agent.nes.start, {});
    check("nes/start returns sessionId (stub)", !!nes.sessionId);
    const suggestions = await ctx.request(acp.methods.agent.nes.suggest, {
      sessionId: nes.sessionId,
      uri: "file:///tmp/x.ts",
      version: 1,
      position: { line: 0, character: 0 },
      triggerKind: "manual",
    });
    check("nes/suggest returns empty (stub)", suggestions.suggestions.length === 0);
    await ctx.request(acp.methods.agent.nes.close, { sessionId: nes.sessionId });
    check("nes/close succeeds (stub)", true);

    await ctx.notify(acp.methods.agent.document.didOpen, {
      sessionId: session.sessionId,
      uri: "file:///tmp/x.ts",
      languageId: "typescript",
      version: 1,
      text: " cons",
    });
    check("document/didOpen accepted (no-op)", true);
  });
  console.log();

  // ── Missing session ──
  console.log("§4  Unknown session");
  let missingFailed = false;
  try {
    await withClient(new FakeBackend("extension"), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1 });
      await ctx.request(acp.methods.agent.session.prompt, {
        sessionId: "missing",
        prompt: [{ type: "text", text: "nope" }],
      });
    });
  } catch {
    missingFailed = true;
  }
  check("prompt for an unknown session fails", missingFailed);
  console.log();

  // ── Cancel ──
  console.log("§5  session/cancel");
  const slow = new FakeBackend("extension");
  slow.delayMs = 5_000;
  slow.chunks = [{ text: "late", done: true }];
  const started = Date.now();
  const cancelled = await withClient(slow, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1 });
    const session = await ctx.request(acp.methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    const pending = ctx.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "slow" }],
    });
    await ctx.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
    return pending;
  });
  const elapsed = Date.now() - started;
  check("cancelled stopReason", cancelled.stopReason === "cancelled", String(cancelled.stopReason));
  check("cancel returns before the backend finishes", elapsed < 4_000, `${elapsed}ms`);
  console.log();

  console.log("╔═══════════════════════════════════════════════════╗");
  console.log(`║  Results:  ✓ ${passed}  ✗ ${failed}`.padEnd(53) + "║");
  console.log("╚═══════════════════════════════════════════════════╝");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n✗ ACP verification crashed:", err);
  process.exit(1);
});
