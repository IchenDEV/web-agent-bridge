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
 *
 * Robustness:
 *   - Uses element-identity tracking (WeakRef to last known element)
 *     instead of fragile count-based detection
 *   - Input is fully cleared before each send
 *   - Scrolls chat to bottom for reliable message detection
 */

const DoubaoAdapter = (() => {

  const SELECTORS = {
    input: '[contenteditable="true"]',
    sendButton: '.send-btn-wrapper button',
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
   */
  function getAssistantMdBoxes() {
    const all = [...document.querySelectorAll(SELECTORS.mdBox)];
    return all.filter((el) => !el.closest('[class*="send-msg-bubble"]'));
  }

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

  /**
   * Snapshot the current last assistant element for identity comparison.
   * Returns null if no assistant boxes exist.
   */
  function snapshotLastAssistant() {
    const boxes = getAssistantMdBoxes();
    return boxes.length > 0 ? boxes[boxes.length - 1] : null;
  }

  /**
   * Check whether a genuinely NEW assistant box appeared after `prevLastEl`.
   * Works even if DOM elements are reordered or counts fluctuate.
   */
  function hasNewAssistantAfter(prevLastEl) {
    const boxes = getAssistantMdBoxes();
    if (boxes.length === 0) return false;
    if (!prevLastEl) return boxes.length > 0;

    const lastNow = boxes[boxes.length - 1];
    if (lastNow === prevLastEl) return false;

    // Extra guard: check that prevLastEl is still in the DOM and the new
    // last element comes AFTER it in document order.
    if (!document.contains(prevLastEl)) return true;
    const position = prevLastEl.compareDocumentPosition(lastNow);
    return !!(position & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function isStillStreaming() {
    const cursor = document.querySelector('[class*="cursor-blink"], [class*="typing-indicator"]');
    if (cursor) return true;

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

  /**
   * Scroll the chat container to the very bottom so the latest messages
   * are rendered and visible to the DOM query.
   */
  function scrollToBottom() {
    const containers = document.querySelectorAll(
      '[class*="chat-body"], [class*="scroll"], [class*="message-list"], [class*="conversation"]'
    );
    for (const c of containers) {
      if (c.scrollHeight > c.clientHeight + 50) {
        c.scrollTop = c.scrollHeight;
      }
    }
  }

  // ── Send a message ──

  async function sendMessage(text) {
    const editor = findInput();
    if (!editor) throw new Error("Chat input not found on page");

    console.log(`[DA] Found editor: ${editor.className.slice(0, 50)}`);

    // Focus and fully clear any leftover content
    editor.focus();
    await sleep(150);

    // Select all + delete to clear
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    await sleep(100);

    // Double-check it's empty; if not, brute-force clear
    if (editor.textContent && editor.textContent.trim().length > 0) {
      editor.textContent = "";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(100);
    }

    // Insert new text
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("insertText", false, text);
    editor.dispatchEvent(new Event("input", { bubbles: true }));

    console.log(`[DA] Text inserted: "${editor.textContent?.slice(0, 40)}"`);
    await sleep(400);

    // Click send button
    const sendBtn = findSendButton();
    if (sendBtn) {
      console.log("[DA] Clicking send button");
      sendBtn.click();
    } else {
      console.log("[DA] No send button, trying Enter key");
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
    }

    console.log("[DA] Message sent");
  }

  // ── Wait for AI response ──

  async function waitForResponse(prevLastEl, timeoutSec = 120) {
    const deadline = Date.now() + timeoutSec * 1000;

    // Phase 1: Wait for a genuinely NEW assistant md-box to appear
    const prevCount = getAssistantMdBoxes().length;
    console.log(`[DA] Waiting... (prev boxes: ${prevCount}, tracking last element)`);

    while (Date.now() < deadline) {
      scrollToBottom();
      if (hasNewAssistantAfter(prevLastEl)) {
        console.log(`[DA] New assistant box detected! (now ${getAssistantMdBoxes().length} boxes)`);
        break;
      }
      await sleep(500);
    }

    if (!hasNewAssistantAfter(prevLastEl)) {
      const allBoxes = getAllMdBoxes().length;
      const assistantBoxes = getAssistantMdBoxes().length;
      throw new Error(
        `Timeout: no new assistant message after ${timeoutSec}s. ` +
          `Assistant boxes: ${assistantBoxes}, All boxes: ${allBoxes}`
      );
    }

    // Phase 2: Wait for content to stabilize (streaming done)
    console.log("[DA] Waiting for response to stabilize...");
    let lastText = "";
    let stableChecks = 0;

    while (Date.now() < deadline) {
      scrollToBottom();
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

      await sleep(500);
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

  async function sendAndWaitForResponse(text, timeoutSec = 120) {
    const prevLastEl = snapshotLastAssistant();
    const prevCount = getAssistantMdBoxes().length;
    console.log(`[DA] Start — assistant boxes: ${prevCount}, all boxes: ${getAllMdBoxes().length}`);

    await sendMessage(text);
    return waitForResponse(prevLastEl, timeoutSec);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  return { sendMessage, waitForResponse, sendAndWaitForResponse };
})();
