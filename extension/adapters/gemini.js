/**
 * Google Gemini DOM Adapter
 *
 * Selectors verified via live browser inspection on gemini.google.com (2026-09-16).
 *
 * DOM structure:
 *   .ql-editor[contenteditable]                  — input (Quill editor inside <rich-textarea>)
 *   button[aria-label="Send message"]            — send button (appears when input has text)
 *   <model-response>                             — assistant response wrapper (web component)
 *   <model-response> message-content .markdown   — markdown content
 *   <user-query>                                 — user message wrapper (web component)
 */

const GeminiAdapter = (() => {

  const INPUT_SELECTORS = [
    '.ql-editor[contenteditable="true"]',
    'rich-textarea [contenteditable="true"]',
    '[aria-label*="prompt"][contenteditable]',
    'div[role="textbox"][contenteditable]',
  ].join(", ");

  const SEND_SELECTORS = [
    'button[aria-label="Send message"]',
    '.send-button button',
    'gem-icon-button.send-button button',
  ].join(", ");

  // ── DOM helpers ──

  function findInput() {
    return document.querySelector(INPUT_SELECTORS);
  }

  function findSendButton() {
    return document.querySelector(SEND_SELECTORS);
  }

  function getModelResponses() {
    return [...document.querySelectorAll("model-response")];
  }

  function extractText(modelResponse) {
    const mc = modelResponse.querySelector("message-content");
    if (mc) {
      const md = mc.querySelector(".markdown");
      if (md) return cleanText(md.textContent || "");
      return cleanText(mc.textContent || "");
    }
    return cleanText(modelResponse.textContent || "");
  }

  function getLastAssistantText() {
    const responses = getModelResponses();
    if (responses.length === 0) return null;
    return extractText(responses[responses.length - 1]);
  }

  function snapshotLastAssistant() {
    const responses = getModelResponses();
    return responses.length > 0 ? responses[responses.length - 1] : null;
  }

  function hasNewAssistantAfter(prevLastEl) {
    const responses = getModelResponses();
    if (responses.length === 0) return false;
    if (!prevLastEl) return responses.length > 0;

    const lastNow = responses[responses.length - 1];
    if (lastNow === prevLastEl) return false;

    if (!document.contains(prevLastEl)) return true;
    const position = prevLastEl.compareDocumentPosition(lastNow);
    return !!(position & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function isStillStreaming() {
    // Gemini shows a "Stop" button during generation
    const stopBtn = document.querySelector(
      'button[aria-label="Stop response"], button[aria-label="Stop generating"]'
    );
    if (stopBtn && stopBtn.offsetParent !== null) return true;

    // Check for loading animation class
    const loading = document.querySelector(
      '[class*="loading-animation"], [class*="generating"], [class*="response-streaming"]'
    );
    return !!loading;
  }

  function cleanText(raw) {
    return raw.replace(/\s+/g, " ").trim();
  }

  function scrollToBottom() {
    const scroller = document.querySelector(
      "infinite-scroller, .chat-history, [class*=\"chat-history\"]"
    );
    if (scroller && scroller.scrollHeight > scroller.clientHeight + 50) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }

  // ── Send a message ──

  async function sendMessage(text) {
    const input = findInput();
    if (!input) throw new Error("Gemini input not found on page");

    console.log(`[GMN] Found input: ${input.className.slice(0, 50)}`);

    input.focus();
    await sleep(150);

    // Clear existing content (Quill editor uses contenteditable)
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    await sleep(100);

    if (input.textContent?.trim()) {
      input.textContent = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(100);
    }

    // Insert text
    document.execCommand("insertText", false, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));

    console.log(`[GMN] Text inserted: "${input.textContent?.slice(0, 40)}"`);
    await sleep(400);

    // Click send button (appears after text is entered)
    const sendBtn = findSendButton();
    if (sendBtn) {
      console.log("[GMN] Clicking send button");
      sendBtn.click();
    } else {
      // Gemini also supports Enter to send
      console.log("[GMN] No send button found, pressing Enter");
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13,
          bubbles: true, cancelable: true,
        })
      );
    }

    console.log("[GMN] Message sent");
  }

  // ── Wait for response ──

  async function waitForResponse(prevLastEl, timeoutSec = 120) {
    const deadline = Date.now() + timeoutSec * 1000;

    console.log(`[GMN] Waiting for new model-response...`);

    // Phase 1: Wait for a new <model-response> element
    while (Date.now() < deadline) {
      scrollToBottom();
      if (hasNewAssistantAfter(prevLastEl)) {
        console.log(`[GMN] New model-response detected`);
        break;
      }
      await sleep(500);
    }

    if (!hasNewAssistantAfter(prevLastEl)) {
      throw new Error(`Timeout: no new Gemini response after ${timeoutSec}s`);
    }

    // Phase 2: Wait for content stabilization
    console.log("[GMN] Waiting for response to stabilize...");
    let lastText = "";
    let stableChecks = 0;

    while (Date.now() < deadline) {
      scrollToBottom();
      const currentText = getLastAssistantText() || "";

      if (currentText.length > 0 && currentText === lastText && !isStillStreaming()) {
        stableChecks++;
        if (stableChecks >= 3) {
          console.log("[GMN] Response stabilized");
          break;
        }
      } else {
        stableChecks = 0;
        lastText = currentText;
      }
      await sleep(500);
    }

    await sleep(300);
    const responseText = getLastAssistantText();

    if (!responseText) {
      throw new Error("Could not extract Gemini response text");
    }

    console.log(`[GMN] ✓ Response (${responseText.length} chars): "${responseText.slice(0, 100)}"`);
    return responseText;
  }

  // ── Public API ──

  async function sendAndWaitForResponse(text, timeoutSec = 120) {
    const prevLastEl = snapshotLastAssistant();
    console.log(`[GMN] Start — model-response elements: ${getModelResponses().length}`);
    await sendMessage(text);
    return waitForResponse(prevLastEl, timeoutSec);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  return { sendMessage, waitForResponse, sendAndWaitForResponse };
})();
