/**
 * Unit tests for BridgeExecutor (A2A event sequencing).
 * Run: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert";
import type { AgentExecutionEvent, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { DefaultExecutionEventBus } from "@a2a-js/sdk/server";
import { Role, TaskState } from "@a2a-js/sdk";
import { BridgeExecutor } from "../../server/bridge-executor.js";
import type { MessageBackend, SendOptions, StreamChunk } from "../../server/message-backend.js";

class FakeBackend implements MessageBackend {
  readonly name = "fake";
  connected = true;
  chunks: StreamChunk[] = [];
  cancelled: string[] = [];
  lastReq: SendOptions | null = null;

  async *sendAndStream(req: SendOptions): AsyncGenerator<StreamChunk> {
    this.lastReq = req;
    for (const chunk of this.chunks) yield chunk;
  }

  async sendAndWait(req: SendOptions): Promise<string> {
    let finalText = "";
    for await (const chunk of this.sendAndStream(req)) {
      if (chunk.done) finalText = chunk.text;
    }
    return finalText;
  }

  cancel(taskId: string): void {
    this.cancelled.push(taskId);
  }

  close(): void {}
}

interface Captured {
  events: AgentExecutionEvent[];
  finished: boolean;
}

function makeBus(): { bus: ExecutionEventBus; captured: Captured } {
  const events: AgentExecutionEvent[] = [];
  const captured: Captured = { events, finished: false };
  const bus = new DefaultExecutionEventBus();
  bus.on("event", (event) => events.push(event));
  bus.on("finished", () => {
    captured.finished = true;
  });
  return { bus, captured };
}

function makeCtx(taskId: string, text: string, metadata?: Record<string, unknown>): RequestContext {
  const userMessage = {
    messageId: `msg-${taskId}`,
    contextId: "ctx-1",
    taskId,
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: "text", value: text },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      },
    ],
    metadata,
    extensions: [],
    referenceTaskIds: [],
  };
  return {
    taskId,
    contextId: "ctx-1",
    userMessage,
    metadata,
  } as unknown as RequestContext;
}

function artifactTexts(captured: Captured): Array<{ text: string; append: boolean; lastChunk: boolean }> {
  return captured.events
    .filter((e) => e.kind === "artifactUpdate")
    .map((e) => {
      const data = e.data as any;
      const part = data.artifact?.parts?.[0];
      return {
        text: part?.content?.value ?? part?.text ?? "",
        append: data.append,
        lastChunk: data.lastChunk,
      };
    });
}

function terminalState(captured: Captured): string | undefined {
  const last = [...captured.events].reverse().find((e) => e.kind === "statusUpdate");
  return last ? (last.data as any).status?.state : undefined;
}

test("streaming turn publishes progressive snapshots then COMPLETED", async () => {
  const backend = new FakeBackend();
  backend.chunks = [
    { text: "Hel", done: false },
    { text: "lo w", done: false },
    { text: "Hello world", done: true },
  ];
  const executor = new BridgeExecutor(backend);
  const { bus, captured } = makeBus();

  await executor.execute(makeCtx("t1", "hi"), bus);

  // Event ordering: task(WORKING) first, artifacts in stream order.
  assert.equal(captured.events[0].kind, "task");
  assert.equal((captured.events[0].data as any).status?.state, TaskState.TASK_STATE_WORKING);

  const arts = artifactTexts(captured);
  assert.deepEqual(arts, [
    { text: "Hel", append: false, lastChunk: false },
    { text: "Hello w", append: false, lastChunk: false },
    { text: "Hello world", append: false, lastChunk: true },
  ]);

  assert.equal(terminalState(captured), TaskState.TASK_STATE_COMPLETED);
  assert.equal(captured.finished, true);
  assert.equal(backend.lastReq?.text, "hi");
});

test("routing metadata reaches the backend", async () => {
  const backend = new FakeBackend();
  backend.chunks = [{ text: "ok", done: true }];
  const executor = new BridgeExecutor(backend);
  const { bus } = makeBus();

  await executor.execute(
    makeCtx("t2", "hi", { "x-target-agent": "doubao", "x-backend": "browser", "x-timeout-ms": "12345" }),
    bus,
  );

  assert.equal(backend.lastReq?.target, "doubao");
  assert.equal(backend.lastReq?.backend, "browser");
  assert.equal(backend.lastReq?.timeoutMs, 12345);
});

test("backend error publishes FAILED with the message", async () => {
  const backend = new FakeBackend();
  backend.chunks = [{ text: "", done: true, error: "extension exploded" }];
  const executor = new BridgeExecutor(backend);
  const { bus, captured } = makeBus();

  await executor.execute(makeCtx("t3", "hi"), bus);

  assert.equal(terminalState(captured), TaskState.TASK_STATE_FAILED);
  const failed = captured.events.find((e) => e.kind === "statusUpdate")!;
  const msg = (failed.data as any).status?.message;
  assert.match(msg?.parts?.[0]?.content?.value ?? "", /extension exploded/);
  assert.equal(captured.finished, true);
});

test("cancelTask cancels the backend and publishes CANCELED", async () => {
  const backend = new FakeBackend();
  const executor = new BridgeExecutor(backend);
  const { bus, captured } = makeBus();

  await executor.cancelTask("t4", bus);

  assert.deepEqual(backend.cancelled, ["t4"]);
  assert.equal(terminalState(captured), TaskState.TASK_STATE_CANCELED);
  assert.equal(captured.finished, true);
});

test("execute after cancelTask reports CANCELED, not FAILED", async () => {
  const backend = new FakeBackend();
  // The stream errors out after the backend gets cancelled.
  backend.chunks = [{ text: "", done: true, error: "Cancelled by client" }];
  const executor = new BridgeExecutor(backend);
  const cancelBus = makeBus();
  await executor.cancelTask("t5", cancelBus.bus);

  const { bus, captured } = makeBus();
  await executor.execute(makeCtx("t5", "hi"), bus);

  const statusUpdates = captured.events.filter((e) => e.kind === "statusUpdate");
  assert.equal(statusUpdates.length, 1);
  assert.equal((statusUpdates[0].data as any).status?.state, TaskState.TASK_STATE_CANCELED);
  assert.equal(captured.finished, true);
});

test("no text part in the message throws a clear error", async () => {
  const backend = new FakeBackend();
  const executor = new BridgeExecutor(backend);
  const { bus } = makeBus();

  const badCtx = {
    taskId: "t6",
    contextId: "ctx-1",
    userMessage: {
      messageId: "m",
      contextId: "ctx-1",
      taskId: "t6",
      role: Role.ROLE_USER,
      parts: [],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    metadata: undefined,
  } as unknown as RequestContext;

  await assert.rejects(() => executor.execute(badCtx, bus), /No text part/);
});