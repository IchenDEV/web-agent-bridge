import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "http";
import { EventEmitter } from "events";

// ── Wire protocol between Server ↔ Extension ──

export interface BridgeSendMessage {
  type: "send";
  taskId: string;
  text: string;
  target?: string; // "doubao" | "workbuddy" | undefined (auto)
}

export interface BridgeStreamChunkMessage {
  type: "stream-chunk";
  taskId: string;
  text: string;
  images?: string[];
}

export interface BridgeResponseMessage {
  type: "response";
  taskId: string;
  text: string;
  parts?: BridgePart[];
  error?: string;
}

export interface BridgePart {
  type: "text" | "image_url" | "file_url";
  content: string;
  mediaType: string;
  filename?: string;
}

export interface BridgePingMessage {
  type: "ping";
}

export interface BridgePongMessage {
  type: "pong";
}

export type BridgeMessage =
  | BridgeSendMessage
  | BridgeStreamChunkMessage
  | BridgeResponseMessage
  | BridgePingMessage
  | BridgePongMessage;

// ── Async queue for streaming chunks ──

export interface StreamChunk {
  text: string;
  done: boolean;
  parts?: BridgePart[];
  error?: string;
}

class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiters: Array<(value: T) => void> = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.buffer.push(item);
  }

  async next(): Promise<T> {
    const item = this.buffer.shift();
    if (item !== undefined) return item;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

// ── WebSocket Bridge Server ──

export class WsBridge extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private pendingRequests = new Map<
    string,
    {
      resolve: (text: string) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private streamQueues = new Map<string, AsyncQueue<StreamChunk>>();

  get connected(): boolean {
    return this.client?.readyState === WebSocket.OPEN;
  }

  private pingInterval: ReturnType<typeof setInterval> | null = null;

  attach(server: HttpServer, path = "/ws"): void {
    this.wss = new WebSocketServer({ server, path });

    this.wss.on("connection", (ws) => {
      console.log("[WsBridge] Extension connected");

      if (this.client && this.client.readyState === WebSocket.OPEN) {
        console.log("[WsBridge] Replacing existing extension connection");
        this.client.close();
      }
      this.client = ws;
      this.emit("connected");

      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 15_000);

      ws.on("message", (raw) => {
        try {
          const msg: BridgeMessage = JSON.parse(raw.toString());
          this.handleMessage(msg);
        } catch (e) {
          console.error("[WsBridge] Bad message:", e);
        }
      });

      ws.on("close", () => {
        console.log("[WsBridge] Extension disconnected");
        if (this.client === ws) this.client = null;
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        this.rejectAllPending("Extension disconnected");
        this.closeAllStreams("Extension disconnected");
        this.emit("disconnected");
      });

      ws.on("error", (err) => {
        console.error("[WsBridge] WS error:", err.message);
      });
    });

    console.log(`[WsBridge] Listening on ws://127.0.0.1:*${path}`);
  }

  /**
   * Send a chat message and return an async generator yielding streaming chunks.
   * The generator yields partial text as it arrives, then the final complete response.
   */
  async *sendAndStream(
    taskId: string,
    text: string,
    timeoutMs = 180_000,
    target?: string
  ): AsyncGenerator<StreamChunk> {
    if (!this.connected) {
      throw new Error("No extension connected");
    }

    const queue = new AsyncQueue<StreamChunk>();
    this.streamQueues.set(taskId, queue);

    const timer = setTimeout(() => {
      queue.push({ text: "", done: true, error: `Timeout waiting for response (taskId: ${taskId})` });
      this.streamQueues.delete(taskId);
    }, timeoutMs);

    const msg: BridgeSendMessage = { type: "send", taskId, text, target };
    this.client!.send(JSON.stringify(msg));
    console.log(`[WsBridge] Sent task ${taskId}: "${text.slice(0, 60)}..."`);

    try {
      while (true) {
        const chunk = await queue.next();
        if (chunk.error) {
          throw new Error(chunk.error);
        }
        yield chunk;
        if (chunk.done) break;
      }
    } finally {
      clearTimeout(timer);
      this.streamQueues.delete(taskId);
    }
  }

  /**
   * Blocking convenience wrapper: send and wait for the complete response.
   */
  async sendAndWait(taskId: string, text: string, timeoutMs = 180_000, target?: string): Promise<string> {
    let finalText = "";
    for await (const chunk of this.sendAndStream(taskId, text, timeoutMs, target)) {
      if (chunk.done) {
        finalText = chunk.text;
      }
    }
    return finalText;
  }

  private handleMessage(msg: BridgeMessage): void {
    switch (msg.type) {
      case "stream-chunk": {
        const queue = this.streamQueues.get(msg.taskId);
        if (queue) {
          queue.push({
            text: msg.text,
            done: false,
          });
        }
        break;
      }
      case "response": {
        // Check if this task is being streamed
        const queue = this.streamQueues.get(msg.taskId);
        if (queue) {
          if (msg.error) {
            queue.push({ text: "", done: true, error: msg.error });
          } else {
            queue.push({
              text: msg.text,
              done: true,
              parts: msg.parts,
            });
          }
          break;
        }
        // Fallback for legacy non-streaming pending requests
        const pending = this.pendingRequests.get(msg.taskId);
        if (!pending) {
          console.warn(`[WsBridge] No pending request for taskId: ${msg.taskId}`);
          return;
        }
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.taskId);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          console.log(`[WsBridge] Got response for ${msg.taskId}: "${msg.text.slice(0, 80)}..."`);
          pending.resolve(msg.text);
        }
        break;
      }
      case "pong":
      case "ping":
        break;
      default:
        console.warn("[WsBridge] Unknown message type:", (msg as any).type);
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  private closeAllStreams(reason: string): void {
    for (const [, queue] of this.streamQueues) {
      queue.push({ text: "", done: true, error: reason });
    }
    this.streamQueues.clear();
  }

  close(): void {
    this.rejectAllPending("Bridge closing");
    this.closeAllStreams("Bridge closing");
    this.client?.close();
    this.wss?.close();
  }
}
