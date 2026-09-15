/**
 * Content Script — runs inside supported AI agent pages.
 *
 * Automatically detects which adapter is loaded (based on the site),
 * receives "send" commands from the background service worker,
 * delegates to the correct adapter, and returns AI responses.
 *
 * Supported adapters:
 *   - DoubaoAdapter   (doubao.com)
 *   - WorkbuddyAdapter (workbuddy.cn)
 */

/* global DoubaoAdapter, WorkbuddyAdapter */

const adapter =
  typeof DoubaoAdapter !== "undefined"
    ? { name: "doubao", impl: DoubaoAdapter }
    : typeof WorkbuddyAdapter !== "undefined"
      ? { name: "workbuddy", impl: WorkbuddyAdapter }
      : null;

if (!adapter) {
  console.error("[Content] No adapter available for", location.hostname);
} else {
  console.log(`[Content] Using adapter: ${adapter.name} on ${location.href}`);
}

chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg.type === "send") {
    handleSend(msg);
  }
  return false;
});

async function handleSend(msg) {
  const { taskId, text } = msg;

  if (!adapter) {
    chrome.runtime.sendMessage({
      type: "response",
      taskId,
      text: "",
      error: `No adapter available for ${location.hostname}`,
    });
    return;
  }

  console.log(`[Content][${adapter.name}] Received task ${taskId}: "${text.slice(0, 60)}"`);

  try {
    const responseText = await adapter.impl.sendAndWaitForResponse(text);
    console.log(
      `[Content][${adapter.name}] Got response for ${taskId}: "${responseText.slice(0, 80)}"`
    );

    chrome.runtime.sendMessage({
      type: "response",
      taskId,
      text: responseText,
    });
  } catch (err) {
    console.error(`[Content][${adapter.name}] Error for task ${taskId}:`, err);

    chrome.runtime.sendMessage({
      type: "response",
      taskId,
      text: "",
      error: err.message || String(err),
    });
  }
}

// Notify background that content script is ready
try {
  chrome.runtime.sendMessage({ type: "content-ready", adapter: adapter?.name || "none" });
} catch (_) {
  // Ignore if background isn't ready yet
}

console.log("[Content] Web Agent Bridge content script loaded on", location.href);
