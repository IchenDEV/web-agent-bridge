/**
 * Content Script — runs inside supported AI agent pages.
 *
 * Automatically detects which adapter is loaded (based on the site),
 * receives "send" commands from the background service worker,
 * delegates to the correct adapter, and returns AI responses.
 *
 * Robustness:
 *   - Guard against duplicate injection (background.js fallback inject)
 *   - Serial task queue to prevent concurrent adapter calls
 *   - Graceful error handling with per-task error reporting
 *
 * Supported adapters:
 *   - DoubaoAdapter   (doubao.com)
 *   - WorkbuddyAdapter (workbuddy.cn)
 */

/* global DoubaoAdapter, WorkbuddyAdapter */

// ── Duplicate injection guard ──
// If the content script is injected a second time (via programmatic injection),
// skip re-initialization to avoid duplicate listeners.
if (window.__webAgentBridgeLoaded) {
  console.log("[Content] Already loaded, skipping duplicate injection");
} else {
  window.__webAgentBridgeLoaded = true;

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

  // ── Serial task queue ──
  // Only one task runs at a time. New tasks wait for the previous one to finish.
  let taskQueue = Promise.resolve();

  function enqueueTask(fn) {
    taskQueue = taskQueue.then(fn, fn);
    return taskQueue;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
    if (msg.type === "send") {
      enqueueTask(() => handleSend(msg));
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

    console.log(`[Content][${adapter.name}] Task ${taskId}: "${text.slice(0, 60)}"`);

    try {
      const responseText = await adapter.impl.sendAndWaitForResponse(text);
      console.log(
        `[Content][${adapter.name}] ✓ ${taskId}: "${responseText.slice(0, 80)}"`
      );

      chrome.runtime.sendMessage({
        type: "response",
        taskId,
        text: responseText,
      });
    } catch (err) {
      console.error(`[Content][${adapter.name}] ✗ ${taskId}:`, err);

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
}
