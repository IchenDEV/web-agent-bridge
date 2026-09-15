/**
 * Service Worker — manages WebSocket to the local A2A server
 * and routes messages between server ↔ content scripts.
 */

const WS_URL = "ws://127.0.0.1:3000/ws";
const RECONNECT_INTERVAL_MS = 3000;

let ws = null;
let reconnectTimer = null;

// ── WebSocket lifecycle ──

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  console.log("[Background] Connecting to", WS_URL);
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("[Background] Connected to A2A server");
    clearReconnectTimer();
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "send") {
        await forwardToContentScript(msg);
      } else if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch (e) {
      console.error("[Background] Bad message:", e);
    }
  };

  ws.onclose = () => {
    console.log("[Background] Disconnected, will reconnect...");
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error("[Background] WS error:", err.message || err);
    ws?.close();
  };
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectTimer = setTimeout(connect, RECONNECT_INTERVAL_MS);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// ── Forward a "send" command to the doubao tab's content script ──

async function forwardToContentScript(msg) {
  const tabs = await chrome.tabs.query({ url: "*://www.doubao.com/chat*" });

  if (tabs.length === 0) {
    console.error("[Background] No doubao.com/chat tab found");
    sendToServer({
      type: "response",
      taskId: msg.taskId,
      text: "",
      error: "No doubao.com/chat tab is open. Please open https://www.doubao.com/chat/ first.",
    });
    return;
  }

  const tab = tabs[0];
  console.log(`[Background] Forwarding task ${msg.taskId} to tab ${tab.id}`);

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "send",
      taskId: msg.taskId,
      text: msg.text,
    });
  } catch (e) {
    console.error("[Background] Failed to send to content script:", e);
    sendToServer({
      type: "response",
      taskId: msg.taskId,
      text: "",
      error: `Content script unreachable: ${e.message}`,
    });
  }
}

// ── Receive responses from content scripts ──

chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg.type === "response") {
    sendToServer(msg);
  }
});

function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    console.error("[Background] Cannot send — WS not connected");
  }
}

// ── Start ──
connect();
