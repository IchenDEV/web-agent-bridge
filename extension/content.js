/**
 * Content Script — runs inside doubao.com pages.
 * Receives "send" commands from the background service worker,
 * delegates to the doubao adapter, and returns AI responses.
 */

/* global DoubaoAdapter */

chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg.type === "send") {
    handleSend(msg);
  }
  return false;
});

async function handleSend(msg) {
  const { taskId, text } = msg;
  console.log(`[Content] Received task ${taskId}: "${text.slice(0, 60)}"`);

  try {
    const responseText = await DoubaoAdapter.sendAndWaitForResponse(text);
    console.log(`[Content] Got response for ${taskId}: "${responseText.slice(0, 80)}"`);

    chrome.runtime.sendMessage({
      type: "response",
      taskId,
      text: responseText,
    });
  } catch (err) {
    console.error(`[Content] Error for task ${taskId}:`, err);

    chrome.runtime.sendMessage({
      type: "response",
      taskId,
      text: "",
      error: err.message || String(err),
    });
  }
}

console.log("[Content] Web Agent Bridge content script loaded on", location.href);
