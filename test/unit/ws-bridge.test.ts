/**
 * Unit tests for WsBridge (server ↔ extension WebSocket protocol).
 * Run: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WsBridge } from "../../server/ws-bridge.js";

/** Boot a WsBridge on an ephemeral port and connect a fake extension client. */
async function startBridge(): Promise<{
  bridge: WsBridge;
  port: number;
  ws: WebSocket;
  received: any[];
  stop: () => Promise<void>;
}> {
  const server = createServer();
  const bridge = new WsBridge();
  bridge.attach(server, "/ws");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const received: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.onmessage = (event) => received.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws connect failed"));
  });
  // WsBridge registers the client on "connection" — wait for it to settle.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const stop = async () => {
    ws.close();
    bridge.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { bridge, port, ws, received, stop };
}

test("streams chunks and final response from the extension", async () => {
  const { bridge, ws, received, stop } = await startBridge();

  const iter = bridge.sendAndStream({ taskId: "t1", text: "你好", timeoutMs: 3_000 });
  const chunks: any[] = [];

  const consumer = (async () => {
    for await (const chunk of iter) chunks.push(chunk);
  })();

  // Reply once the server's "send" arrives.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no send message received")), 2_000);
    const check = setInterval(() => {
      const send = received.find((m) => m.type === "send" && m.taskId === "t1");
      if (send) {
        clearInterval(check);
        clearTimeout(timer);
        assert.equal(send.text, "你好");
        assert.ok(typeof send.timeoutMs === "number" && send.timeoutMs > 0);
        ws.send(JSON.stringify({ type: "stream-chunk", taskId: "t1", text: "你" }));
        ws.send(JSON.stringify({ type: "stream-chunk", taskId: "t1", text: "好" }));
        ws.send(JSON.stringify({ type: "response", taskId: "t1", text: "你好！" }));
        resolve();
      }
    }, 20);
  });

  await consumer;
  assert.equal(chunks.length, 3);
  assert.deepEqual(
    chunks.map((c) => ({ text: c.text, done: c.done })),
    [
      { text: "你", done: false },
      { text: "好", done: false },
      { text: "你好！", done: true },
    ],
  );

  await stop();
});

test("error responses fail the stream", async () => {
  const { bridge, ws, received, stop } = await startBridge();

  const iter = bridge.sendAndStream({ taskId: "t2", text: "x", timeoutMs: 3_000 });
  const consumer = (async () => {
    for await (const _ of iter) {
      /* drain */
    }
  })();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no send message received")), 2_000);
    const check = setInterval(() => {
      if (received.some((m) => m.type === "send" && m.taskId === "t2")) {
        clearInterval(check);
        clearTimeout(timer);
        ws.send(JSON.stringify({ type: "response", taskId: "t2", text: "", error: "page broken" }));
        resolve();
      }
    }, 20);
  });

  await assert.rejects(() => consumer, /page broken/);
  await stop();
});

test("timeout fires when the extension never responds", async () => {
  const { bridge, stop } = await startBridge();

  const iter = bridge.sendAndStream({ taskId: "t3", text: "x", timeoutMs: 150 });
  await assert.rejects(
    async () => {
      for await (const _ of iter) {
        /* drain */
      }
    },
    /Timeout waiting for response/,
  );

  await stop();
});

test("cancel ends the wait locally and notifies the extension", async () => {
  const { bridge, ws, received, stop } = await startBridge();

  const iter = bridge.sendAndStream({ taskId: "t4", text: "x", timeoutMs: 10_000 });
  const consumer = (async () => {
    for await (const _ of iter) {
      /* drain */
    }
  })();

  // Let the send propagate, then cancel from the server side.
  await new Promise((resolve) => setTimeout(resolve, 50));
  bridge.cancel("t4");

  await assert.rejects(() => consumer, /Cancelled by client/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    received.some((m) => m.type === "cancel" && m.taskId === "t4"),
    "extension should receive the cancel message",
  );

  await stop();
});

test("extension disconnect rejects in-flight streams", async () => {
  const { bridge, ws, stop } = await startBridge();

  const iter = bridge.sendAndStream({ taskId: "t5", text: "x", timeoutMs: 10_000 });
  const consumer = (async () => {
    for await (const _ of iter) {
      /* drain */
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, 50));
  ws.close();
  await assert.rejects(() => consumer, /Extension disconnected/);
  assert.equal(bridge.connected, false);

  await stop();
});