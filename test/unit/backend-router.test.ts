/**
 * Unit tests for BackendRouter routing & cancellation.
 * Run: npm run test:unit  (node:test + tsx, no extra dependencies)
 */

import test from "node:test";
import assert from "node:assert";
import { BackendRouter, type MessageBackend, type SendOptions, type StreamChunk } from "../../server/message-backend.js";

class FakeBackend implements MessageBackend {
  constructor(
    readonly name: string,
    public connected = true,
    public chunks: StreamChunk[] = [{ text: `reply-from-${name}`, done: true }],
  ) {}
  cancelled: string[] = [];
  lastReq: SendOptions | null = null;
  statusDetails: (() => Record<string, unknown>) | undefined = undefined;

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

  close(): void {
    this.connected = false;
  }
}

test("routes to the explicit backend when it is connected", async () => {
  const a = new FakeBackend("a");
  const b = new FakeBackend("b");
  const router = new BackendRouter("a");
  router.register(a);
  router.register(b);

  const reply = await router.sendAndWait({ taskId: "t1", text: "hi", backend: "b" });
  assert.equal(reply, "reply-from-b");
  assert.equal(b.lastReq?.text, "hi");
  assert.equal(a.lastReq, null);
});

test("falls back to the default backend when explicit backend is disconnected", async () => {
  const a = new FakeBackend("a", true);
  const b = new FakeBackend("b", false);
  const router = new BackendRouter("a");
  router.register(a);
  router.register(b);

  const reply = await router.sendAndWait({ taskId: "t2", text: "hi", backend: "b" });
  assert.equal(reply, "reply-from-a");
});

test("falls back to any connected backend when default is disconnected", async () => {
  const ext = new FakeBackend("extension", false);
  const browser = new FakeBackend("browser", true);
  const router = new BackendRouter("extension");
  router.register(ext);
  router.register(browser);

  assert.equal(router.connected, true);
  const reply = await router.sendAndWait({ taskId: "t3", text: "hi" });
  assert.equal(reply, "reply-from-browser");
});

test("throws when no backend is connected", async () => {
  const a = new FakeBackend("a", false);
  const router = new BackendRouter("a");
  router.register(a);

  await assert.rejects(
    () => router.sendAndWait({ taskId: "t4", text: "hi" }),
    /No connected backend available/,
  );
});

test("unknown explicit backend falls back instead of failing", async () => {
  const a = new FakeBackend("a");
  const router = new BackendRouter("a");
  router.register(a);

  const reply = await router.sendAndWait({ taskId: "t5", text: "hi", backend: "nope" });
  assert.equal(reply, "reply-from-a");
});

test("cancel broadcasts to every backend", () => {
  const a = new FakeBackend("a");
  const b = new FakeBackend("b");
  const router = new BackendRouter("a");
  router.register(a);
  router.register(b);

  router.cancel("task-x");
  assert.deepEqual(a.cancelled, ["task-x"]);
  assert.deepEqual(b.cancelled, ["task-x"]);
});

test("cancel tolerates throwing backends", () => {
  const bad: MessageBackend = {
    name: "bad",
    connected: true,
    async *sendAndStream() {
      throw new Error("unreachable");
    },
    async sendAndWait() {
      throw new Error("unreachable");
    },
    cancel() {
      throw new Error("boom");
    },
    close() {},
  };
  const good = new FakeBackend("good");
  const router = new BackendRouter("good");
  router.register(bad);
  router.register(good);

  router.cancel("task-y");
  assert.deepEqual(good.cancelled, ["task-y"]);
});

test("status aggregates backend details", () => {
  const a = new FakeBackend("a", true);
  a.statusDetails = () => ({ pages: ["doubao"] });
  const router = new BackendRouter("a");
  router.register(a);

  const status = router.status();
  assert.equal(status.a.connected, true);
  assert.deepEqual(status.a.pages, ["doubao"]);
});