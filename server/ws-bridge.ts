import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "http";
import { EventEmitter } from "events";

// ── Wire protocol between Server ↔ Extension ──

export interface BridgeSendMessage {
  type: "send";
  taskId: string;
  text: string;
}

export interface BridgeResponseMessage {
  type: "response";
  taskId: string;
  text: string;
  error?: string;
}

export interface BridgePingMessage {
  type: "ping";
}

export interface BridgePongMessage {
  type: "pong";
}

export type BridgeMessage =
  | BridgeSendMessage
  | BridgeResponseMessage
  | BridgePingMessage
  | BridgePongMessage;

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

  get connected(): boolean {
    return this.client?.readyState === WebSocket.OPEN;
  }

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
        this.rejectAllPending("Extension disconnected");
        this.emit("disconnected");
      });

      ws.on("error", (err) => {
        console.error("[WsBridge] WS error:", err.message);
      });
    });

    console.log(`[WsBridge] Listening on ws://127.0.0.1:*${path}`);
  }

  /**
   * Send a chat message to the extension and wait for the AI response.
   * Returns the response text or throws on timeout / disconnect.
   */
  sendAndWait(taskId: string, text: string, timeoutMs = 120_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (!this.connected) {
        return reject(new Error("No extension connected"));
      }

      const timer = setTimeout(() => {
        this.pendingRequests.delete(taskId);
        reject(new Error(`Timeout waiting for response (taskId: ${taskId})`));
      }, timeoutMs);

      this.pendingRequests.set(taskId, { resolve, reject, timer });

      const msg: BridgeSendMessage = { type: "send", taskId, text };
      this.client!.send(JSON.stringify(msg));
      console.log(`[WsBridge] Sent task ${taskId}: "${text.slice(0, 60)}..."`);
    });
  }

  private handleMessage(msg: BridgeMessage): void {
    switch (msg.type) {
      case "response": {
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
          console.log(
            `[WsBridge] Got response for ${msg.taskId}: "${msg.text.slice(0, 80)}..."`
          );
          pending.resolve(msg.text);
        }
        break;
      }
      case "pong":
        break;
      default:
        console.warn("[WsBridge] Unknown message type:", (msg as any).type);
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [taskId, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  close(): void {
    this.rejectAllPending("Bridge closing");
    this.client?.close();
    this.wss?.close();
  }
}
