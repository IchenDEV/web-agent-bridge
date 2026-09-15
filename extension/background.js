/**
 * Service Worker — manages WebSocket to the local A2A server
 * and routes messages between server ↔ content scripts.
 *
 * Supports multiple AI agent sites. When a "send" command arrives,
 * tries known URL patterns in order until a matching tab is found.
 *
 * Uses chrome.alarms for reconnection (setTimeout is unreliable in MV3
 * because the service worker can be terminated at any time).
 */

const WS_URL = "ws://127.0.0.1:3000/ws";
const ALARM_NAME = "ws-reconnect";
const KEEPALIVE_ALARM = "ws-keepalive";

/**
 * Supported AI agent tab URL patterns.
 * Order matters — first match wins.
 */
const AGENT_TAB_PATTERNS = [
  { name: "doubao", pattern: "*://www.doubao.com/chat*" },
  { name: "workbuddy", pattern: "*://www.workbuddy.cn/app*" },
];

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
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 / 3 });
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
  };
}

function scheduleReconnect() {
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.05 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log("[Background] Reconnect alarm fired...");
    connect();
  } else if (alarm.name === KEEPALIVE_ALARM) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }
});

// ── Forward a "send" command to a supported AI agent tab ──

async function forwardToContentScript(msg) {
  // Try each known agent pattern until we find an open tab
  for (const { name, pattern } of AGENT_TAB_PATTERNS) {
    const tabs = await chrome.tabs.query({ url: pattern });
    if (tabs.length > 0) {
      const tab = tabs[0];
      console.log(`[Background] Found ${name} tab (${tab.id}), forwarding task ${msg.taskId}`);

      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: "send",
          taskId: msg.taskId,
          text: msg.text,
        });
        return;
      } catch (e) {
        console.error(`[Background] Failed to send to ${name} tab:`, e);
        sendToServer({
          type: "response",
          taskId: msg.taskId,
          text: "",
          error: `Content script unreachable on ${name} tab: ${e.message}. Try refreshing the page.`,
        });
        return;
      }
    }
  }

  // No matching tab found
  const patterns = AGENT_TAB_PATTERNS.map((p) => p.name).join(", ");
  console.error(`[Background] No supported AI agent tab found (tried: ${patterns})`);
  sendToServer({
    type: "response",
    taskId: msg.taskId,
    text: "",
    error:
      `No supported AI agent tab is open. ` +
      `Please open one of: https://www.doubao.com/chat/ or https://www.workbuddy.cn/app`,
  });
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
