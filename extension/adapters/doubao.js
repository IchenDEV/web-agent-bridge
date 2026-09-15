/**
 * Doubao (豆包) DOM Adapter
 *
 * Selectors verified via live CDP + user DOM inspection on doubao.com (2026-09-16).
 * 
 * DOM structure:
 *   .md-box-root         — present in BOTH user and assistant messages
 *   bg-g-send-msg-bubble — ancestor class for USER messages only
 *   .send-btn-wrapper    — contains the send button
 *   .tiptap.ProseMirror  — contenteditable input (Tiptap editor)
 */

const DoubaoAdapter = (() => {

  const SELECTORS = {
    // Tiptap ProseMirror editor
    input: '[contenteditable="true"]',

    // Send button (inside .send-btn-wrapper)
    sendButton: '.send-btn-wrapper button',

    // All rendered message content blocks (both user and assistant)
    mdBox: '.md-box-root',
  };

  const NOISE_PATTERNS = [
    "内容由豆包 AI 生成，请仔细甄别",
    "请仔细甄别",
    "下载电脑版",
    "内容由 AI 生成",
  ];

  // ── DOM helpers ──

  function findInput() {
    return document.querySelector(SELECTORS.input);
  }

  function findSendButton() {
    return document.querySelector(SELECTORS.sendButton);
  }

  /**
   * Get all .md-box-root elements that are NOT inside a user message bubble.
   * User messages have an ancestor with class containing "send-msg-bubble".
   */
  function getAssistantMdBoxes() {
    const all = [...document.querySelectorAll(SELECTORS.mdBox)];
    return all.filter((el) => !el.closest('[class*="send-msg-bubble"]'));
  }

  /**
   * Get ALL .md-box-root elements (user + assistant).
   */
  function getAllMdBoxes() {
    return [...document.querySelectorAll(SELECTORS.mdBox)];
  }

  function extractText(el) {
    return cleanText(el.textContent || "");
  }

  function getLastAssistantText() {
    const boxes = getAssistantMdBoxes();
    if (boxes.length === 0) return null;
    return extractText(boxes[boxes.length - 1]);
  }

  function isStillStreaming() {
    // Check if text in the last assistant box is still changing
    // Also look for cursor/typing indicators
    const cursor = document.querySelector('[class*="cursor-blink"], [class*="typing-indicator"]');
    if (cursor) return true;

    // Check for any loading spinners near messages
    const boxes = getAssistantMdBoxes();
    if (boxes.length === 0) return false;
    const last = boxes[boxes.length - 1];
    const parent = last.closest('[class*="flex"]');
    if (parent && parent.querySelector('[class*="loading"], [class*="spinner"]')) return true;

    return false;
  }

  function cleanText(raw) {
    let text = raw.replace(/\s+/g, " ").trim();
    for (const noise of NOISE_PATTERNS) {
      text = text.replace(noise, "").trim();
    }
    return text;
  }

  // ── Send a message ──

  async function sendMessage(text) {
    const editor = findInput();
    if (!editor) throw new Error("Chat input not found on page");

    console.log(`[DA] Found editor: ${editor.className.slice(0, 50)}`);

    editor.focus();
    await sleep(200);

    // Insert text into Tiptap editor
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("insertText", false, text);
    editor.dispatchEvent(new Event("input", { bubbles: true }));

    console.log(`[DA] Text inserted, editor content: "${editor.textContent?.slice(0, 40)}"`);
    await sleep(500);

    // Click send button
    const sendBtn = findSendButton();
    if (sendBtn) {
      console.log("[DA] Clicking send button");
      sendBtn.click();
    } else {
      console.log("[DA] No send button, trying Enter key");
      editor.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
    }

    console.log("[DA] Message sent");
  }

  // ── Wait for AI response ──

  async function waitForResponse(prevAssistantCount, timeoutSec = 90) {
    const deadline = Date.now() + timeoutSec * 1000;

    // Phase 1: Wait for a new ASSISTANT md-box to appear
    console.log(`[DA] Waiting... (prev assistant boxes: ${prevAssistantCount})`);

    while (Date.now() < deadline) {
      const current = getAssistantMdBoxes().length;
      if (current > prevAssistantCount) {
        console.log(`[DA] New assistant box! (${prevAssistantCount} -> ${current})`);
        break;
      }
      await sleep(600);
    }

    if (getAssistantMdBoxes().length <= prevAssistantCount) {
      const allBoxes = getAllMdBoxes().length;
      throw new Error(
        `Timeout: no new assistant message. ` +
        `Assistant boxes: ${getAssistantMdBoxes().length}, All boxes: ${allBoxes}`
      );
    }

    // Phase 2: Wait for content to stabilize (streaming done)
    console.log("[DA] Waiting for response to stabilize...");
    let lastText = "";
    let stableChecks = 0;

    while (Date.now() < deadline) {
      const currentText = getLastAssistantText() || "";

      if (currentText.length > 0 && currentText === lastText && !isStillStreaming()) {
        stableChecks++;
        if (stableChecks >= 3) {
          console.log("[DA] Response stabilized");
          break;
        }
      } else {
        stableChecks = 0;
        lastText = currentText;
      }

      await sleep(600);
    }

    // Phase 3: Extract final text
    await sleep(300);
    const responseText = getLastAssistantText();

    if (!responseText) {
      throw new Error("Could not extract assistant response text");
    }

    console.log(`[DA] ✓ Response (${responseText.length} chars): "${responseText.slice(0, 100)}"`);
    return responseText;
  }

  // ── Public API ──

  async function sendAndWaitForResponse(text, timeoutSec = 90) {
    const prevCount = getAssistantMdBoxes().length;
    console.log(`[DA] Start — assistant boxes: ${prevCount}, all boxes: ${getAllMdBoxes().length}`);

    await sendMessage(text);
    return waitForResponse(prevCount, timeoutSec);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  return { sendMessage, waitForResponse, sendAndWaitForResponse };
})();
