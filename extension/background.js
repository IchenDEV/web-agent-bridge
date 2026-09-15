/**
 * Service Worker — manages WebSocket to the local A2A server
 * and routes messages between server ↔ content scripts.
 *
 * Uses chrome.alarms for reconnection (setTimeout is unreliable in MV3
 * because the service worker can be terminated at any time).
 */

const WS_URL = "ws://127.0.0.1:3000/ws";
const ALARM_NAME = "ws-reconnect";
const KEEPALIVE_ALARM = "ws-keepalive";

let ws = null;

// ── WebSocket lifecycle ──

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  console.log("[Background] Connecting to", WS_URL);
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("[Background] ✓ Connected to A2A server");
    chrome.alarms.clear(ALARM_NAME);
    // Start keepalive ping every 20 seconds to prevent service worker suspension
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 / 3 }); // ~20s
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
    console.log("[Background] Disconnected, scheduling reconnect...");
    ws = null;
    chrome.alarms.clear(KEEPALIVE_ALARM);
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error("[Background] WS error");
    // onclose will fire after onerror
  };
}

function scheduleReconnect() {
  // chrome.alarms minimum period is 0.5 minutes for periodic,
  // but delayInMinutes with a small value works for one-shot
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.05 }); // ~3 seconds
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log("[Background] Reconnect alarm fired...");
    connect();
  } else if (alarm.name === KEEPALIVE_ALARM) {
    // Send keepalive ping to prevent MV3 service worker from being terminated
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }
});

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
      error: `Content script unreachable: ${e.message}. Try refreshing the doubao.com/chat tab.`,
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

// ── Also try to connect when the service worker starts ──
connect();

// ── Reconnect when extension is installed/updated ──
chrome.runtime.onInstalled.addListener(() => {
  console.log("[Background] Extension installed/updated, connecting...");
  connect();
});
