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
  {
    name: "chatgpt",
    pattern: "*://chatgpt.com/*",
    scripts: ["adapters/chatgpt.js", "content.js"],
  },
  {
    name: "gemini",
    pattern: "*://gemini.google.com/*",
    scripts: ["adapters/gemini.js", "content.js"],
  },
  {
    name: "perplexity",
    pattern: "*://www.perplexity.ai/*",
    scripts: ["adapters/perplexity.js", "content.js"],
  },
  {
    name: "perplexity",
    pattern: "*://perplexity.ai/*",
    scripts: ["adapters/perplexity.js", "content.js"],
  },
  {
    name: "kimi",
    pattern: "*://www.kimi.com/*",
    scripts: ["adapters/kimi.js", "content.js"],
  },
  {
    name: "kimi",
    pattern: "*://kimi.moonshot.cn/*",
    scripts: ["adapters/kimi.js", "content.js"],
  },
  {
    name: "qianwen",
    pattern: "*://www.qianwen.com/*",
    scripts: ["adapters/qianwen.js", "content.js"],
  },
  {
    name: "qianwen",
    pattern: "*://chat.qwen.ai/*",
    scripts: ["adapters/qianwen.js", "content.js"],
  },
  {
    name: "qianwen",
    pattern: "*://tongyi.aliyun.com/*",
    scripts: ["adapters/qianwen.js", "content.js"],
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

// ── Pending task safety timeouts ──
const pendingTasks = new Map(); // taskId → { timer, name }

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log("[Background] Reconnect alarm fired...");
    connect();
  } else if (alarm.name === KEEPALIVE_ALARM) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  } else if (alarm.name.startsWith("safety-")) {
    const taskId = alarm.name.slice("safety-".length);
    const pending = pendingTasks.get(taskId);
    if (pending) {
      console.error(`[Background] Safety alarm: task ${taskId} timed out`);
      pendingTasks.delete(taskId);
      sendToServer({
        type: "response",
        taskId,
        text: "",
        error: `Timeout: ${pending.name} content script did not respond. The page may require login.`,
      });
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

// ── Default URLs for auto-opening agent tabs ──

const AGENT_DEFAULT_URLS = {
  doubao:     "https://www.doubao.com/chat/",
  workbuddy:  "https://www.workbuddy.cn/app",
  chatgpt:    "https://chatgpt.com/",
  gemini:     "https://gemini.google.com/app",
  perplexity: "https://www.perplexity.ai/",
  kimi:       "https://www.kimi.com/",
  qianwen:    "https://www.qianwen.com/",
};

/**
 * Wait for a tab to finish loading by polling its status.
 * More reliable than onUpdated in MV3 service workers.
 */
async function waitForTabReady(tabId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") {
        console.log(`[Background] Tab ${tabId} loaded: ${tab.url}`);
        return tab;
      }
    } catch (e) {
      throw new Error(`Tab ${tabId} no longer exists`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error("Tab load timeout");
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

  // ── Step 1: Find an existing tab ──
  let matchedAgent = null;

  for (const agent of patterns) {
    const tabs = await chrome.tabs.query({ url: agent.pattern });
    if (tabs.length > 0) {
      matchedAgent = { ...agent, tab: tabs[0] };
      break;
    }
  }

  // ── Step 2: Auto-open a tab if none found ──
  if (!matchedAgent) {
    const targetName = msg.target || patterns[0]?.name;
    const defaultUrl = AGENT_DEFAULT_URLS[targetName];

    if (!defaultUrl) {
      sendToServer({
        type: "response",
        taskId: msg.taskId,
        text: "",
        error: `No "${targetName}" tab open and no default URL configured.`,
      });
      return;
    }

    console.log(`[Background] No ${targetName} tab found, auto-opening ${defaultUrl}`);

    try {
      const newTab = await chrome.tabs.create({ url: defaultUrl, active: true });
      console.log(`[Background] Created tab ${newTab.id} for ${targetName}, waiting for load...`);

      const readyTab = await waitForTabReady(newTab.id, 60000);

      // Extra wait for JS frameworks to initialize (React, Angular, etc.)
      await new Promise((r) => setTimeout(r, 3000));

      const agent = patterns.find((p) => p.name === targetName) || patterns[0];
      matchedAgent = { ...agent, tab: readyTab };
    } catch (e) {
      console.error(`[Background] Failed to auto-open ${targetName}:`, e);
      sendToServer({
        type: "response",
        taskId: msg.taskId,
        text: "",
        error: `Failed to auto-open ${targetName} tab: ${e.message}`,
      });
      return;
    }
  }

  // ── Step 3: Send message to the tab ──
  const { name, scripts, tab } = matchedAgent;
  console.log(`[Background] Using ${name} tab (id=${tab.id}), forwarding task ${msg.taskId}`);

  // Register safety alarm (survives service worker suspension)
  pendingTasks.set(msg.taskId, { name });
  chrome.alarms.create(`safety-${msg.taskId}`, { delayInMinutes: 1.5 }); // 90 seconds

  function clearSafety() {
    pendingTasks.delete(msg.taskId);
    chrome.alarms.clear(`safety-${msg.taskId}`);
  }

  async function trySend() {
    // Attempt 1: direct send
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "send",
        taskId: msg.taskId,
        text: msg.text,
      });
      return;
    } catch (e) {
      console.warn(`[Background] Direct send failed (${name}): ${e.message}`);
      console.log("[Background] Injecting content scripts...");
    }

    // Attempt 2: inject scripts and retry
    const injected = await injectContentScripts(tab.id, scripts);
    if (!injected) {
      clearSafety();
      sendToServer({
        type: "response",
        taskId: msg.taskId,
        text: "",
        error: `Failed to inject content scripts on ${name} tab. Check extension permissions.`,
      });
      return;
    }

    await new Promise((r) => setTimeout(r, 1500));

    // Retry send
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "send",
        taskId: msg.taskId,
        text: msg.text,
      });
    } catch (e2) {
      clearSafety();
      console.error(`[Background] Retry failed (${name}):`, e2);
      sendToServer({
        type: "response",
        taskId: msg.taskId,
        text: "",
        error: `Content script unreachable on ${name} tab: ${e2.message}`,
      });
    }
  }

  await trySend();
}

// ── Receive responses from content scripts & settings changes ──

chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg.type === "response") {
    // Clear safety alarm for this task
    if (msg.taskId && pendingTasks.has(msg.taskId)) {
      pendingTasks.delete(msg.taskId);
      chrome.alarms.clear(`safety-${msg.taskId}`);
    }
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
