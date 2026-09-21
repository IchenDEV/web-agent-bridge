/**
 * ACP stdio transport.
 *
 * Editors spawn this process and speak newline-delimited JSON-RPC on
 * stdin/stdout. Logs go to stderr so they don't corrupt the protocol stream.
 *
 *   WAB_ACP_BACKEND=extension  proxy prompts to a running `wab server` (default)
 *   WAB_ACP_BACKEND=browser    drive the page with local Playwright
 */
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import type { MessageBackend, StreamChunk } from "./message-backend.js";
import { createWebAgentApp } from "./acp-agent.js";

console.log = console.error;

class A2AProxyBackend implements MessageBackend {
  readonly name = "extension";

  constructor(private baseUrl: string) {}

  get connected(): boolean {
    return true;
  }

  async *sendAndStream(
    taskId: string,
    text: string,
    timeoutMs = 180_000,
    target?: string,
  ): AsyncGenerator<StreamChunk> {
    const reply = await this.sendAndWait(taskId, text, timeoutMs, target);
    yield { text: reply, done: true };
  }

  async sendAndWait(
    _taskId: string,
    text: string,
    timeoutMs = 180_000,
    target?: string,
  ): Promise<string> {
    const metadata: Record<string, string> = { "x-backend": "extension" };
    if (target) metadata["x-target-agent"] = target;

    const body = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "SendMessage",
      params: {
        message: {
          messageId: crypto.randomUUID(),
          contextId: crypto.randomUUID(),
          taskId: "",
          role: "ROLE_USER",
          parts: [{ text, mediaType: "text/plain" }],
          metadata,
        },
        metadata,
      },
    };

    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/a2a`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `A2A server not reachable at ${this.baseUrl} (${message}). Start it with: wab server`,
      );
    }

    if (!resp.ok) {
      throw new Error(`A2A HTTP ${resp.status}: ${await resp.text()}`);
    }

    const rpc = (await resp.json()) as {
      error?: { message?: string };
      result?: { task?: A2ATask } & A2ATask;
    };
    if (rpc.error) {
      throw new Error(rpc.error.message || "A2A request failed");
    }

    const task = rpc.result?.task || rpc.result;
    const state = task?.status?.state;
    if (state === "TASK_STATE_FAILED" || state === 4) {
      const errText = (task?.status?.message?.parts || [])
        .map((part) => part.text || "")
        .filter(Boolean)
        .join("\n");
      throw new Error(errText || "Task failed");
    }

    const texts: string[] = [];
    for (const art of task?.artifacts || []) {
      for (const part of art.parts || []) {
        const value = part.text || part.content?.value || "";
        if (value) texts.push(value);
      }
    }
    if (texts.length === 0) throw new Error("A2A response had no text");
    return texts.join("\n");
  }

  close(): void {}
}

interface A2ATask {
  status?: { state?: string | number; message?: { parts?: Array<{ text?: string }> } };
  artifacts?: Array<{ parts?: Array<{ text?: string; content?: { value?: string } }> }>;
}

async function createBackend(): Promise<MessageBackend> {
  const which = process.env.WAB_ACP_BACKEND || "extension";
  if (which === "browser") {
    const { BrowserBackend } = await import("./browser-backend.js");
    const backend = new BrowserBackend();
    await backend.connect(process.env.CDP_URL || undefined);
    console.error(`[ACP] browser backend ready${process.env.CDP_URL ? ` (CDP ${process.env.CDP_URL})` : ""}`);
    return backend;
  }
  if (which !== "extension") {
    throw new Error(`Unknown WAB_ACP_BACKEND "${which}". Use "extension" or "browser".`);
  }
  const baseUrl = process.env.WAB_SERVER || "http://127.0.0.1:3000";
  console.error(`[ACP] extension backend via ${baseUrl}`);
  return new A2AProxyBackend(baseUrl);
}

const backend = await createBackend();
const agent = createWebAgentApp(backend);

const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(output, input);
const connection = agent.connect(stream);

connection.closed.then(() => {
  backend.close();
  process.exit(0);
});
