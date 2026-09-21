/**
 * ACP v1 agent for web-agent-bridge.
 *
 * Wires every agent-side method exposed by `@agentclientprotocol/sdk`.
 * Session lifecycle, modes, config, and dialogue are real.
 * NES / providers / document / MCP are accepted as safe stubs where the
 * underlying web-chat backends cannot fulfill editor/LLM semantics —
 * those capabilities are not advertised in `initialize`.
 */

import * as acp from "@agentclientprotocol/sdk";
import type {
  AuthenticateRequest,
  AuthenticateResponse,
  AvailableCommand,
  CancelNotification,
  CloseNesRequest,
  CloseSessionRequest,
  ContentBlock,
  DeleteSessionRequest,
  DisableProviderRequest,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListProvidersRequest,
  ListProvidersResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  LogoutRequest,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionInfo,
  SessionModeState,
  SetProviderRequest,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  StartNesRequest,
  StartNesResponse,
  SuggestNesRequest,
  SuggestNesResponse,
} from "@agentclientprotocol/sdk";
import { agentCard } from "./agent-card.js";
import { ADAPTERS } from "./browser-adapters/index.js";
import { BackendRouter, type MessageBackend } from "./message-backend.js";

const AGENT_OPTIONS = ["auto", ...ADAPTERS.map((a) => a.name)] as const;
const BACKEND_OPTIONS = ["auto", "extension", "browser"] as const;
const PAGE_SIZE = 50;

const MODES: SessionModeState["availableModes"] = [
  {
    id: "chat",
    name: "Chat",
    description: "Forward prompts to a web AI agent (Doubao / ChatGPT / Gemini / WorkBuddy)",
  },
];

interface HistoryEntry {
  role: "user" | "assistant";
  messageId: string;
  text: string;
}

interface AcpSession {
  sessionId: string;
  cwd: string;
  additionalDirectories: string[];
  target: string;
  backend: string;
  modeId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  closed: boolean;
  pending: AbortController | null;
  history: HistoryEntry[];
  commandsSent: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function metaString(meta: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = meta?.[key];
  if (value == null || value === "") return undefined;
  return String(value);
}

function promptText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "resource" && "text" in block.resource && block.resource.text) {
      parts.push(block.resource.text);
    } else if (block.type === "resource_link") {
      parts.push(block.uri);
    } else if (block.type === "image") {
      parts.push("[image]");
    } else if (block.type === "audio") {
      parts.push("[audio]");
    }
  }
  const text = parts.join("\n").trim();
  if (!text) throw acp.RequestError.invalidParams(undefined, "Prompt has no text content");
  return text;
}

function abortPromise(signal: AbortSignal): Promise<"aborted"> {
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
}

function modeState(currentModeId: string): SessionModeState {
  return { currentModeId, availableModes: MODES };
}

function buildConfigOptions(session: AcpSession): SessionConfigOption[] {
  return [
    {
      id: "target-agent",
      name: "Target agent",
      description: "Which web AI site to drive",
      type: "select",
      currentValue: session.target,
      options: AGENT_OPTIONS.map((value) => ({
        value,
        name: value === "auto" ? "Auto (open tab / default)" : value,
      })),
    },
    {
      id: "backend",
      name: "Backend",
      description: "Chrome extension bridge or Playwright browser automation",
      type: "select",
      currentValue: session.backend,
      options: BACKEND_OPTIONS.map((value) => ({
        value,
        name: value,
      })),
    },
  ];
}

function availableCommands(): AvailableCommand[] {
  return [
    {
      name: "status",
      description: "Show current target agent and backend",
    },
    {
      name: "agent",
      description: "Set target agent for this session",
      input: { hint: AGENT_OPTIONS.join("|") },
    },
    {
      name: "backend",
      description: "Set message backend for this session",
      input: { hint: BACKEND_OPTIONS.join("|") },
    },
  ];
}

function toSessionInfo(session: AcpSession): SessionInfo {
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    additionalDirectories: session.additionalDirectories,
    title: session.title,
    updatedAt: session.updatedAt,
    _meta: {
      closed: session.closed,
      target: session.target,
      backend: session.backend,
      messageCount: session.history.length,
    },
  };
}

function titleFromPrompt(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= 48 ? oneLine : `${oneLine.slice(0, 45)}...`;
}

async function notifyUpdate(
  client: acp.AgentContext,
  sessionId: string,
  update: acp.SessionUpdate,
): Promise<void> {
  await client.notify(acp.methods.client.session.update, { sessionId, update });
}

/**
 * ACP agent that forwards each prompt turn to a MessageBackend
 * (Chrome extension, Playwright, or the router in front of both).
 */
export class WebAcpAgent {
  private sessions = new Map<string, AcpSession>();
  private nesSessions = new Set<string>();

  constructor(private backend: MessageBackend) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        sessionCapabilities: {
          list: {},
          delete: {},
          additionalDirectories: {},
          fork: {},
          resume: {},
          close: {},
        },
        auth: {
          logout: {},
        },
        // providers / nes intentionally omitted — stubbed handlers exist but
        // web-chat backends cannot fulfill those editor/LLM surfaces.
      },
      agentInfo: {
        name: "web-agent-bridge",
        title: agentCard.name,
        version: agentCard.version,
      },
      // No protocol-driven login; browser login is handled by Dia/CDP or `wab login`.
      authMethods: [],
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    // authMethods is empty — clients SHOULD NOT call this. Accept no-op for resilience.
    return {};
  }

  async logout(_params: LogoutRequest): Promise<Record<string, never>> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    const session = this.createSession({
      sessionId,
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories ?? [],
      target: metaString(params._meta, "x-target-agent") ?? "auto",
      backend: metaString(params._meta, "x-backend") ?? "auto",
    });
    this.sessions.set(sessionId, session);
    console.error(`[ACP] session/new ${sessionId}`);

    // Do not emit session/update during session/new: HTTP transports can drop
    // mid-request notifications. Commands are pushed on first prompt / load / resume.

    return {
      sessionId,
      modes: modeState(session.modeId),
      configOptions: buildConfigOptions(session),
    };
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    let sessions = [...this.sessions.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    if (params.cwd) {
      sessions = sessions.filter((s) => s.cwd === params.cwd);
    }

    let offset = 0;
    if (params.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(params.cursor, "base64url").toString("utf8")) as {
          offset?: number;
        };
        offset = Number(parsed.offset) || 0;
      } catch {
        throw acp.RequestError.invalidParams(undefined, "Invalid session/list cursor");
      }
    }

    const page = sessions.slice(offset, offset + PAGE_SIZE);
    const nextOffset = offset + page.length;
    const nextCursor =
      nextOffset < sessions.length
        ? Buffer.from(JSON.stringify({ offset: nextOffset }), "utf8").toString("base64url")
        : null;

    return {
      sessions: page.map(toSessionInfo),
      nextCursor,
    };
  }

  async loadSession(
    params: LoadSessionRequest,
    client: acp.AgentContext,
  ): Promise<LoadSessionResponse> {
    const session = this.requireSession(params.sessionId);
    this.assertCwd(session, params.cwd);
    session.additionalDirectories = params.additionalDirectories ?? [];
    session.closed = false;
    session.updatedAt = nowIso();

    for (const entry of session.history) {
      await notifyUpdate(client, session.sessionId, {
        sessionUpdate: entry.role === "user" ? "user_message_chunk" : "agent_message_chunk",
        messageId: entry.messageId,
        content: { type: "text", text: entry.text },
      });
    }

    session.commandsSent = false;
    await this.ensureCommands(session, client);

    console.error(`[ACP] session/load ${params.sessionId} (${session.history.length} msgs)`);
    return {
      modes: modeState(session.modeId),
      configOptions: buildConfigOptions(session),
    };
  }

  async resumeSession(
    params: ResumeSessionRequest,
    client?: acp.AgentContext,
  ): Promise<ResumeSessionResponse> {
    const session = this.requireSession(params.sessionId);
    this.assertCwd(session, params.cwd);
    session.additionalDirectories = params.additionalDirectories ?? [];
    session.closed = false;
    session.updatedAt = nowIso();
    session.commandsSent = false;
    if (client) await this.ensureCommands(session, client);
    console.error(`[ACP] session/resume ${params.sessionId}`);
    return {
      modes: modeState(session.modeId),
      configOptions: buildConfigOptions(session),
    };
  }

  async closeSession(params: CloseSessionRequest): Promise<Record<string, never>> {
    const session = this.requireSession(params.sessionId);
    session.pending?.abort();
    session.pending = null;
    session.closed = true;
    session.updatedAt = nowIso();
    console.error(`[ACP] session/close ${params.sessionId}`);
    return {};
  }

  async deleteSession(params: DeleteSessionRequest): Promise<Record<string, never>> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw acp.RequestError.invalidParams(undefined, `Session ${params.sessionId} not found`);
    session.pending?.abort();
    this.sessions.delete(params.sessionId);
    console.error(`[ACP] session/delete ${params.sessionId}`);
    return {};
  }

  async forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    const source = this.requireSession(params.sessionId);
    const sessionId = crypto.randomUUID();
    const forked = this.createSession({
      sessionId,
      cwd: params.cwd || source.cwd,
      additionalDirectories: params.additionalDirectories ?? [...source.additionalDirectories],
      target: source.target,
      backend: source.backend,
    });
    forked.modeId = source.modeId;
    forked.title = source.title ? `${source.title} (fork)` : null;
    forked.history = source.history.map((entry) => ({ ...entry }));
    this.sessions.set(sessionId, forked);
    console.error(`[ACP] session/fork ${params.sessionId} -> ${sessionId}`);
    return {
      sessionId,
      modes: modeState(forked.modeId),
      configOptions: buildConfigOptions(forked),
    };
  }

  async setMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.requireActiveSession(params.sessionId);
    if (!MODES.some((m) => m.id === params.modeId)) {
      throw acp.RequestError.invalidParams(undefined, `Unknown mode "${params.modeId}"`);
    }
    session.modeId = params.modeId;
    session.updatedAt = nowIso();
    return {};
  }

  async setConfigOption(
    params: SetSessionConfigOptionRequest,
    client?: acp.AgentContext,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.requireActiveSession(params.sessionId);
    if (!("type" in params) || params.type !== "boolean") {
      const value = String(params.value);
      if (params.configId === "target-agent") {
        if (!AGENT_OPTIONS.includes(value as (typeof AGENT_OPTIONS)[number])) {
          throw acp.RequestError.invalidParams(undefined, `Unknown target-agent "${value}"`);
        }
        session.target = value;
      } else if (params.configId === "backend") {
        if (!BACKEND_OPTIONS.includes(value as (typeof BACKEND_OPTIONS)[number])) {
          throw acp.RequestError.invalidParams(undefined, `Unknown backend "${value}"`);
        }
        session.backend = value;
      } else {
        throw acp.RequestError.invalidParams(undefined, `Unknown config option "${params.configId}"`);
      }
    } else {
      throw acp.RequestError.invalidParams(undefined, `Config option "${params.configId}" is not boolean`);
    }

    session.updatedAt = nowIso();
    const configOptions = buildConfigOptions(session);
    if (client) {
      await notifyUpdate(client, session.sessionId, {
        sessionUpdate: "config_option_update",
        configOptions,
      });
    }
    return { configOptions };
  }

  async prompt(params: PromptRequest, client: acp.AgentContext): Promise<PromptResponse> {
    const session = this.requireActiveSession(params.sessionId);
    await this.ensureCommands(session, client);

    session.pending?.abort();
    const abort = new AbortController();
    session.pending = abort;

    const text = promptText(params.prompt);
    const metaTarget = metaString(params._meta, "x-target-agent");
    const metaBackend = metaString(params._meta, "x-backend");
    if (metaTarget) session.target = metaTarget;
    if (metaBackend) session.backend = metaBackend;

    const userMessageId = crypto.randomUUID();
    session.history.push({ role: "user", messageId: userMessageId, text });
    if (!session.title) session.title = titleFromPrompt(text);
    session.updatedAt = nowIso();

    await notifyUpdate(client, session.sessionId, {
      sessionUpdate: "user_message_chunk",
      messageId: userMessageId,
      content: { type: "text", text },
    });
    await notifyUpdate(client, session.sessionId, {
      sessionUpdate: "session_info_update",
      title: session.title,
      updatedAt: session.updatedAt,
    });

    const slash = await this.trySlashCommand(session, text, client, abort.signal);
    if (slash) {
      if (session.pending === abort) session.pending = null;
      return slash;
    }

    const target = session.target === "auto" ? undefined : session.target;
    const backendName = session.backend === "auto" ? undefined : session.backend;
    const taskId = crypto.randomUUID();

    console.error(
      `[ACP] prompt ${params.sessionId} | backend: ${backendName || "auto"} | agent: ${target || "auto"} | "${text.slice(0, 80)}"`,
    );

    try {
      const stream =
        this.backend instanceof BackendRouter
          ? this.backend.sendAndStreamVia(backendName, taskId, text, 180_000, target)
          : this.backend.sendAndStream(taskId, text, 180_000, target);

      let streamed = "";
      const agentMessageId = crypto.randomUUID();
      while (true) {
        const next = await Promise.race([stream.next(), abortPromise(abort.signal)]);
        if (next === "aborted") {
          return { stopReason: "cancelled" };
        }
        if (next.done) break;

        const chunk = next.value;
        if (chunk.error) throw new Error(chunk.error);

        if (!chunk.done && chunk.text) {
          streamed += chunk.text;
          await notifyUpdate(client, params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            messageId: agentMessageId,
            content: { type: "text", text: chunk.text },
          });
          continue;
        }

        if (chunk.done && chunk.text && !streamed) {
          streamed = chunk.text;
          await notifyUpdate(client, params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            messageId: agentMessageId,
            content: { type: "text", text: chunk.text },
          });
        }
        if (chunk.done) break;
      }

      if (streamed) {
        session.history.push({ role: "assistant", messageId: agentMessageId, text: streamed });
        session.updatedAt = nowIso();
      }

      return { stopReason: abort.signal.aborted ? "cancelled" : "end_turn" };
    } catch (err) {
      if (abort.signal.aborted) return { stopReason: "cancelled" };
      throw err;
    } finally {
      if (session.pending === abort) session.pending = null;
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    console.error(`[ACP] cancel ${params.sessionId}`);
    this.sessions.get(params.sessionId)?.pending?.abort();
  }

  // ── Providers (unstable; not advertised) ──

  async listProviders(_params: ListProvidersRequest): Promise<ListProvidersResponse> {
    return { providers: [] };
  }

  async setProvider(_params: SetProviderRequest): Promise<Record<string, never>> {
    throw acp.RequestError.methodNotFound(acp.methods.agent.providers.set);
  }

  async disableProvider(_params: DisableProviderRequest): Promise<Record<string, never>> {
    throw acp.RequestError.methodNotFound(acp.methods.agent.providers.disable);
  }

  // ── NES (unstable; not advertised) ──

  async nesStart(_params: StartNesRequest): Promise<StartNesResponse> {
    const sessionId = crypto.randomUUID();
    this.nesSessions.add(sessionId);
    return { sessionId };
  }

  async nesSuggest(_params: SuggestNesRequest): Promise<SuggestNesResponse> {
    return { suggestions: [] };
  }

  async nesClose(params: CloseNesRequest): Promise<Record<string, never>> {
    this.nesSessions.delete(params.sessionId);
    return {};
  }

  async nesAccept(): Promise<void> {
    /* no-op */
  }

  async nesReject(): Promise<void> {
    /* no-op */
  }

  // ── Document sync (notifications; no editor model) ──

  async documentDidOpen(): Promise<void> {
    /* no-op — web chat agents do not track editor buffers */
  }

  async documentDidChange(): Promise<void> {
    /* no-op */
  }

  async documentDidClose(): Promise<void> {
    /* no-op */
  }

  async documentDidSave(): Promise<void> {
    /* no-op */
  }

  async documentDidFocus(): Promise<void> {
    /* no-op */
  }

  // ── internals ──

  private createSession(init: {
    sessionId: string;
    cwd: string;
    additionalDirectories: string[];
    target: string;
    backend: string;
  }): AcpSession {
    const ts = nowIso();
    return {
      sessionId: init.sessionId,
      cwd: init.cwd,
      additionalDirectories: init.additionalDirectories,
      target: init.target,
      backend: init.backend,
      modeId: "chat",
      title: null,
      createdAt: ts,
      updatedAt: ts,
      closed: false,
      pending: null,
      history: [],
      commandsSent: false,
    };
  }

  private async ensureCommands(session: AcpSession, client: acp.AgentContext): Promise<void> {
    if (session.commandsSent) return;
    await notifyUpdate(client, session.sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: availableCommands(),
    });
    session.commandsSent = true;
  }

  private requireSession(sessionId: string): AcpSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw acp.RequestError.invalidParams(undefined, `Session ${sessionId} not found`);
    }
    return session;
  }

  private requireActiveSession(sessionId: string): AcpSession {
    const session = this.requireSession(sessionId);
    if (session.closed) {
      throw acp.RequestError.invalidParams(
        undefined,
        `Session ${sessionId} is closed; call session/resume or session/load first`,
      );
    }
    return session;
  }

  private assertCwd(session: AcpSession, cwd: string): void {
    if (session.cwd !== cwd) {
      throw acp.RequestError.invalidParams(
        undefined,
        `cwd mismatch: session is "${session.cwd}", request has "${cwd}"`,
      );
    }
  }

  private async trySlashCommand(
    session: AcpSession,
    text: string,
    client: acp.AgentContext,
    signal: AbortSignal,
  ): Promise<PromptResponse | null> {
    if (!text.startsWith("/")) return null;
    const [cmd, ...rest] = text.slice(1).trim().split(/\s+/);
    const arg = rest.join(" ").trim();
    let reply: string | null = null;

    if (cmd === "status") {
      reply = `target-agent=${session.target}\nbackend=${session.backend}\nmode=${session.modeId}\nhistory=${session.history.length}`;
    } else if (cmd === "agent") {
      if (!arg || !AGENT_OPTIONS.includes(arg as (typeof AGENT_OPTIONS)[number])) {
        reply = `Usage: /agent ${AGENT_OPTIONS.join("|")}`;
      } else {
        session.target = arg;
        reply = `target-agent set to ${arg}`;
        await notifyUpdate(client, session.sessionId, {
          sessionUpdate: "config_option_update",
          configOptions: buildConfigOptions(session),
        });
      }
    } else if (cmd === "backend") {
      if (!arg || !BACKEND_OPTIONS.includes(arg as (typeof BACKEND_OPTIONS)[number])) {
        reply = `Usage: /backend ${BACKEND_OPTIONS.join("|")}`;
      } else {
        session.backend = arg;
        reply = `backend set to ${arg}`;
        await notifyUpdate(client, session.sessionId, {
          sessionUpdate: "config_option_update",
          configOptions: buildConfigOptions(session),
        });
      }
    } else {
      return null;
    }

    if (signal.aborted) return { stopReason: "cancelled" };

    const messageId = crypto.randomUUID();
    session.history.push({ role: "assistant", messageId, text: reply });
    session.updatedAt = nowIso();
    await notifyUpdate(client, session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text: reply },
    });
    return { stopReason: "end_turn" };
  }
}

/** Build an ACP AgentApp wired to the given backend. */
export function createWebAgentApp(backend: MessageBackend): acp.AgentApp {
  const agent = new WebAcpAgent(backend);
  return acp
    .agent({ name: "web-agent-bridge" })
    .onRequest(acp.methods.agent.initialize, (ctx) => agent.initialize(ctx.params))
    .onRequest(acp.methods.agent.authenticate, (ctx) => agent.authenticate(ctx.params))
    .onRequest(acp.methods.agent.logout, (ctx) => agent.logout(ctx.params))
    .onRequest(acp.methods.agent.providers.list, (ctx) => agent.listProviders(ctx.params))
    .onRequest(acp.methods.agent.providers.set, (ctx) => agent.setProvider(ctx.params))
    .onRequest(acp.methods.agent.providers.disable, (ctx) => agent.disableProvider(ctx.params))
    .onRequest(acp.methods.agent.session.new, (ctx) => agent.newSession(ctx.params))
    .onRequest(acp.methods.agent.session.list, (ctx) => agent.listSessions(ctx.params))
    .onRequest(acp.methods.agent.session.load, (ctx) => agent.loadSession(ctx.params, ctx.client))
    .onRequest(acp.methods.agent.session.resume, (ctx) => agent.resumeSession(ctx.params, ctx.client))
    .onRequest(acp.methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
    .onRequest(acp.methods.agent.session.delete, (ctx) => agent.deleteSession(ctx.params))
    .onRequest(acp.methods.agent.session.fork, (ctx) => agent.forkSession(ctx.params))
    .onRequest(acp.methods.agent.session.setMode, (ctx) => agent.setMode(ctx.params))
    .onRequest(acp.methods.agent.session.setConfigOption, (ctx) =>
      agent.setConfigOption(ctx.params, ctx.client),
    )
    .onRequest(acp.methods.agent.session.prompt, (ctx) => agent.prompt(ctx.params, ctx.client))
    .onRequest(acp.methods.agent.nes.start, (ctx) => agent.nesStart(ctx.params))
    .onRequest(acp.methods.agent.nes.suggest, (ctx) => agent.nesSuggest(ctx.params))
    .onRequest(acp.methods.agent.nes.close, (ctx) => agent.nesClose(ctx.params))
    .onNotification(acp.methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params))
    .onNotification(acp.methods.agent.nes.accept, () => agent.nesAccept())
    .onNotification(acp.methods.agent.nes.reject, () => agent.nesReject())
    .onNotification(acp.methods.agent.document.didOpen, () => agent.documentDidOpen())
    .onNotification(acp.methods.agent.document.didChange, () => agent.documentDidChange())
    .onNotification(acp.methods.agent.document.didClose, () => agent.documentDidClose())
    .onNotification(acp.methods.agent.document.didSave, () => agent.documentDidSave())
    .onNotification(acp.methods.agent.document.didFocus, () => agent.documentDidFocus());
}
