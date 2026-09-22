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
 *   - DoubaoAdapter     (doubao.com)
 *   - WorkbuddyAdapter  (workbuddy.cn)
 *   - ChatGPTAdapter    (chatgpt.com)
 *   - GeminiAdapter     (gemini.google.com)
 *   - PerplexityAdapter (perplexity.ai)
 *   - KimiAdapter       (kimi.com / kimi.moonshot.cn)
 *   - QianwenAdapter    (qianwen.com / chat.qwen.ai)
 */

/* global DoubaoAdapter, WorkbuddyAdapter, ChatGPTAdapter, GeminiAdapter, PerplexityAdapter, KimiAdapter, QianwenAdapter */

// ── Injection guard with extension reload detection ──
// Uses extension ID + session to detect stale guards from old extension instances.
const BRIDGE_SESSION = chrome.runtime.id + "_" + Date.now();

// Check if the existing guard is from the same extension instance
const isStale = window.__webAgentBridgeLoaded && (() => {
  try {
    // If we can send a message, the extension context is alive → not stale
    chrome.runtime.sendMessage({ type: "ping" });
    return false;
  } catch {
    // Extension context invalidated (extension was reloaded) → stale
    return true;
  }
})();

if (window.__webAgentBridgeLoaded && !isStale) {
  console.log("[Content] Already loaded, skipping duplicate injection");
} else {
  if (isStale) {
    console.log("[Content] Stale guard detected (extension reloaded), re-initializing...");
  }
  window.__webAgentBridgeLoaded = BRIDGE_SESSION;

  const adapter =
    typeof DoubaoAdapter !== "undefined"
      ? { name: "doubao", impl: DoubaoAdapter }
      : typeof WorkbuddyAdapter !== "undefined"
        ? { name: "workbuddy", impl: WorkbuddyAdapter }
        : typeof ChatGPTAdapter !== "undefined"
          ? { name: "chatgpt", impl: ChatGPTAdapter }
          : typeof GeminiAdapter !== "undefined"
            ? { name: "gemini", impl: GeminiAdapter }
            : typeof PerplexityAdapter !== "undefined"
              ? { name: "perplexity", impl: PerplexityAdapter }
              : typeof KimiAdapter !== "undefined"
                ? { name: "kimi", impl: KimiAdapter }
                : typeof QianwenAdapter !== "undefined"
                  ? { name: "qianwen", impl: QianwenAdapter }
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

    // Race the adapter call against a hard 80-second timeout
    // (must be shorter than background.js's 90s safety alarm)
    try {
      const responseText = await Promise.race([
        adapter.impl.sendAndWaitForResponse(text),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error(
            `Content script timeout (80s) on ${adapter.name}. ` +
            `URL: ${location.href}. The adapter may not support this page state.`
          )), 80_000)
        ),
      ]);

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
