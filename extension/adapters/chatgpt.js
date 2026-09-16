/**
 * ChatGPT DOM Adapter
 *
 * Selectors based on community research and open-source projects (2026-09).
 *
 * DOM structure:
 *   #prompt-textarea / [data-testid="prompt-textarea"]   — input (textarea or contenteditable)
 *   button[data-testid="send-button"]                     — send button
 *   [data-message-author-role="assistant"] .markdown.prose — assistant response content
 *   [data-message-author-role="user"]                     — user message
 *   [data-testid^="conversation-turn-"]                   — turn wrapper
 */

const ChatGPTAdapter = (() => {

  const INPUT_SELECTORS = [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    '[contenteditable="true"][data-lexical-editor="true"]',
    'div[placeholder*="Message"][contenteditable]',
  ].join(", ");

  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send"]',
  ].join(", ");

  const ASSISTANT_SELECTOR = [
    '[data-message-author-role="assistant"]',
    '[data-testid^="conversation-turn-"][data-turn="assistant"]',
    '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
  ].join(", ");

  // ── DOM helpers ──

  function findInput() {
    return document.querySelector(INPUT_SELECTORS);
  }

  function findSendButton() {
    return document.querySelector(SEND_SELECTORS);
  }

  function getAssistantTurns() {
    return [...document.querySelectorAll(ASSISTANT_SELECTOR)];
  }

  function extractText(turnEl) {
    const md = turnEl.querySelector('.markdown.prose, .markdown, [class*="markdown"]');
    if (md) return cleanText(md.textContent || "");
    return cleanText(turnEl.textContent || "");
  }

  function getLastAssistantText() {
    const turns = getAssistantTurns();
    if (turns.length === 0) return null;
    return extractText(turns[turns.length - 1]);
  }

  function snapshotLastAssistant() {
    const turns = getAssistantTurns();
    return turns.length > 0 ? turns[turns.length - 1] : null;
  }

  function hasNewAssistantAfter(prevLastEl) {
    const turns = getAssistantTurns();
    if (turns.length === 0) return false;
    if (!prevLastEl) return turns.length > 0;

    const lastNow = turns[turns.length - 1];
    if (lastNow === prevLastEl) return false;

    if (!document.contains(prevLastEl)) return true;
    const position = prevLastEl.compareDocumentPosition(lastNow);
    return !!(position & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function isStillStreaming() {
    const indicators = document.querySelectorAll(
      '[class*="result-streaming"], [class*="thinking"], [data-testid="loading"]'
    );
    if (indicators.length > 0) return true;

    // Check for a "Stop" button which appears during streaming
    const stopBtn = document.querySelector(
      'button[aria-label="Stop generating"], button[data-testid="stop-button"]'
    );
    return !!stopBtn;
  }

  function cleanText(raw) {
    return raw.replace(/\s+/g, " ").trim();
  }

  function scrollToBottom() {
    const containers = document.querySelectorAll(
      '[class*="react-scroll-to-bottom"], [class*="conversation"], main'
    );
    for (const c of containers) {
      if (c.scrollHeight > c.clientHeight + 50) {
        c.scrollTop = c.scrollHeight;
      }
    }
  }

  /**
   * Wait for the input element to appear (page may still be loading).
   */
  async function waitForInput(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = findInput();
      if (el) return el;
      await sleep(500);
    }
    throw new Error(
      `ChatGPT input not found within ${timeoutMs / 1000}s. ` +
      `Page URL: ${location.href}. ` +
      `You may need to log in or dismiss any dialogs.`
    );
  }

  // ── Send a message ──

  async function sendMessage(text) {
    const input = await waitForInput();

    console.log(`[CGP] Found input: ${input.tagName}#${input.id}`);

    input.focus();
    await sleep(150);

    // Clear existing content
    if (input.tagName === "TEXTAREA") {
      // Native textarea
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value"
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        input.value = "";
      }
      await sleep(100);

      // Set new value
      if (nativeSetter) {
        nativeSetter.call(input, text);
      } else {
        input.value = text;
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      // Contenteditable div (Lexical editor)
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
      await sleep(100);
      if (input.textContent?.trim()) {
        input.textContent = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(100);
      }
      document.execCommand("insertText", false, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    console.log(`[CGP] Text set: "${text.slice(0, 40)}"`);
    await sleep(400);

    // Click send button
    const sendBtn = findSendButton();
    if (sendBtn) {
      console.log("[CGP] Clicking send button");
      sendBtn.click();
    } else {
      console.log("[CGP] No send button found, pressing Enter");
      const target = input;
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13,
          bubbles: true, cancelable: true,
        })
      );
    }

    console.log("[CGP] Message sent");
  }

  // ── Wait for response ──

  async function waitForResponse(prevLastEl, timeoutSec = 120) {
    const deadline = Date.now() + timeoutSec * 1000;

    console.log(`[CGP] Waiting for new assistant turn...`);

    // Phase 1: Wait for new assistant turn
    while (Date.now() < deadline) {
      scrollToBottom();
      if (hasNewAssistantAfter(prevLastEl)) {
        console.log(`[CGP] New assistant turn detected`);
        break;
      }
      await sleep(500);
    }

    if (!hasNewAssistantAfter(prevLastEl)) {
      throw new Error(`Timeout: no new assistant message after ${timeoutSec}s`);
    }

    // Phase 2: Wait for stabilization
    console.log("[CGP] Waiting for response to stabilize...");
    let lastText = "";
    let stableChecks = 0;

    while (Date.now() < deadline) {
      scrollToBottom();
      const currentText = getLastAssistantText() || "";

      if (currentText.length > 0 && currentText === lastText && !isStillStreaming()) {
        stableChecks++;
        if (stableChecks >= 3) {
          console.log("[CGP] Response stabilized");
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
      throw new Error("Could not extract ChatGPT response text");
    }

    console.log(`[CGP] ✓ Response (${responseText.length} chars): "${responseText.slice(0, 100)}"`);
    return responseText;
  }

  // ── Public API ──

  async function sendAndWaitForResponse(text, timeoutSec = 90) {
    const prevLastEl = snapshotLastAssistant();
    console.log(`[CGP] Start — assistant turns: ${getAssistantTurns().length}`);
    await sendMessage(text);
    return waitForResponse(prevLastEl, timeoutSec);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  return { sendMessage, waitForResponse, sendAndWaitForResponse };
})();
