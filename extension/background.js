/**
 * Service Worker — manages WebSocket to the local A2A server
 * and routes messages between server ↔ content scripts.
 *
 * Supports multiple AI agent sites. When a "send" command arrives,
 * tries known URL patterns in order until a matching tab is found.
 * If the content script is unreachable, auto-injects it via scripting API.
 *
 * Uses chrome.alarms for reconnection (setTimeout is unreliable in MV3
 * because the service worker can be terminated at any time).
 */

const WS_URL = "ws://127.0.0.1:3000/ws";
const ALARM_NAME = "ws-reconnect";
const KEEPALIVE_ALARM = "ws-keepalive";

/**
 * Supported AI agent tab URL patterns and their content script files.
 * Order matters — first match wins.
 */
const AGENT_TAB_PATTERNS = [
  {
    name: "doubao",
    pattern: "*://www.doubao.com/chat*",
    scripts: ["adapters/doubao.js", "content.js"],
  },
  {
    name: "workbuddy",
    pattern: "*://www.workbuddy.cn/app*",
    scripts: ["adapters/workbuddy.js", "content.js"],
  },
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

// ── Programmatic content script injection ──

async function injectContentScripts(tabId, scripts) {
  console.log(`[Background] Injecting content scripts into tab ${tabId}:`, scripts);
  try {
    for (const file of scripts) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [file],
      });
    }
    console.log(`[Background] ✓ Content scripts injected into tab ${tabId}`);
    return true;
  } catch (e) {
    console.error(`[Background] Failed to inject content scripts:`, e);
    return false;
  }
}

// ── Forward a "send" command to a supported AI agent tab ──

async function forwardToContentScript(msg) {
  for (const { name, pattern, scripts } of AGENT_TAB_PATTERNS) {
    const tabs = await chrome.tabs.query({ url: pattern });
    if (tabs.length === 0) continue;

    const tab = tabs[0];
    console.log(`[Background] Found ${name} tab (id=${tab.id}), forwarding task ${msg.taskId}`);

    // Attempt 1: try sending directly
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "send",
        taskId: msg.taskId,
        text: msg.text,
      });
      return;
    } catch (e) {
      console.warn(`[Background] Direct send failed (${name}): ${e.message}`);
      console.log("[Background] Attempting programmatic injection...");
    }

    // Attempt 2: inject content scripts and retry
    const injected = await injectContentScripts(tab.id, scripts);
    if (!injected) {
      sendToServer({
        type: "response",
        taskId: msg.taskId,
        text: "",
        error: `Failed to inject content scripts on ${name} tab. Check extension permissions.`,
      });
      return;
    }

    // Wait for scripts to initialize
    await new Promise((r) => setTimeout(r, 1000));

    // Retry send
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "send",
        taskId: msg.taskId,
        text: msg.text,
      });
      return;
    } catch (e2) {
      console.error(`[Background] Retry also failed (${name}):`, e2);
      sendToServer({
        type: "response",
        taskId: msg.taskId,
        text: "",
        error: `Content script unreachable on ${name} tab after injection: ${e2.message}`,
      });
      return;
    }
  }

  // No matching tab found
  const names = AGENT_TAB_PATTERNS.map((p) => p.name).join(", ");
  console.error(`[Background] No supported AI agent tab found (tried: ${names})`);
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
