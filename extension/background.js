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
 *
 * Features:
 *   - Dynamic server URL from chrome.storage.local
 *   - Badge indicator: green = connected, red = disconnected
 *   - Responds to settings-changed messages from options page
 */

const DEFAULT_WS_URL = "ws://127.0.0.1:3000/ws";
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
let connecting = false; // guard against concurrent connect() calls

// ── Badge helpers ──

function setBadge(state) {
  const config = {
    connected:    { text: "", color: "#22c55e" },   // green dot via icon tint
    disconnected: { text: "!", color: "#ef4444" },   // red exclamation
    connecting:   { text: "…", color: "#eab308" },   // yellow ellipsis
  };
  const c = config[state] || config.disconnected;
  chrome.action.setBadgeText({ text: c.text });
  chrome.action.setBadgeBackgroundColor({ color: c.color });
  chrome.action.setBadgeTextColor({ color: "#ffffff" });
}

// ── Get WS URL from storage ──

async function getWsUrl() {
  try {
    const { serverUrl } = await chrome.storage.local.get("serverUrl");
    if (serverUrl) {
      const u = new URL(serverUrl);
      u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
      u.pathname = "/ws";
      return u.toString();
    }
  } catch (_) {}
  return DEFAULT_WS_URL;
}

// ── WebSocket lifecycle ──

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (connecting) return;
  connecting = true;

  let wsUrl;
  try {
    wsUrl = await getWsUrl();
  } catch (_) {
    wsUrl = DEFAULT_WS_URL;
  }

  // Re-check after async gap
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    connecting = false;
    return;
  }

  console.log("[Background] Connecting to", wsUrl);
  setBadge("connecting");

  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    console.error("[Background] WebSocket construction failed:", e);
    connecting = false;
    setBadge("disconnected");
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connecting = false;
    console.log("[Background] ✓ Connected to A2A server");
    setBadge("connected");
    chrome.alarms.clear(ALARM_NAME);
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
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
    connecting = false;
    console.log("[Background] Disconnected, scheduling reconnect...");
    ws = null;
    setBadge("disconnected");
    chrome.alarms.clear(KEEPALIVE_ALARM);
    scheduleReconnect();
  };

  ws.onerror = () => {
    connecting = false;
    console.error("[Background] WS error");
    setBadge("disconnected");
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
  // If a target agent is specified, only try that one
  const patterns = msg.target
    ? AGENT_TAB_PATTERNS.filter((p) => p.name === msg.target)
    : AGENT_TAB_PATTERNS;

  if (msg.target && patterns.length === 0) {
    sendToServer({
      type: "response",
      taskId: msg.taskId,
      text: "",
      error: `Unknown target agent "${msg.target}". Available: ${AGENT_TAB_PATTERNS.map((p) => p.name).join(", ")}`,
    });
    return;
  }

  for (const { name, pattern, scripts } of patterns) {
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
  const tried = patterns.map((p) => p.name).join(", ");
  console.error(`[Background] No agent tab found (tried: ${tried})`);

  const hint = msg.target
    ? `No "${msg.target}" tab is open.`
    : `No supported AI agent tab is open.`;
  sendToServer({
    type: "response",
    taskId: msg.taskId,
    text: "",
    error: `${hint} Please open: https://www.doubao.com/chat/ or https://www.workbuddy.cn/app`,
  });
}

// ── Receive responses from content scripts & settings changes ──

chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg.type === "response") {
    sendToServer(msg);
  } else if (msg.type === "settings-changed") {
    console.log("[Background] Settings changed, reconnecting...");
    if (ws) {
      ws.close();
    }
    connect();
  }
});

function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    console.error("[Background] Cannot send — WS not connected");
  }
}

// ── Initial connection ──
setBadge("disconnected");
connect();

// ── Reconnect when extension is installed/updated ──
chrome.runtime.onInstalled.addListener(() => {
  console.log("[Background] Extension installed/updated, connecting...");
  connect();
});
