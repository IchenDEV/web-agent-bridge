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

  /**
   * True while Doubao is still working — including tool/Feishu pauses where
   * assistant text is temporarily unchanged.
   *
   * Live signals (doubao.com):
   *   - send button disabled / send-msg-btn-di… while generating
   *   - animate-spin / loading / spinner / skeleton in the chat surface
   *   - short status lines (“正在加载技能 / 正在搜索 / 正在读取…”)
   */
  function isStillStreaming() {
    const sendBtn = findSendButton();
    if (sendBtn) {
      const cls = typeof sendBtn.className === "string" ? sendBtn.className : "";
      if (sendBtn.disabled || /send-msg-btn-di|disabled|cursor-not-allowed/i.test(cls)) {
        return true;
      }
    }

    for (const btn of document.querySelectorAll("button")) {
      const label = `${btn.getAttribute("aria-label") || ""} ${(btn.textContent || "").trim()}`;
      if (/^(停止|停止生成|Stop|Stop generating)$/i.test(label.trim())) {
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
    }

    const chatRoot =
      document.querySelector('[class*="message-list"], [class*="chat-body"], main') || document.body;
    if (
      chatRoot.querySelector(
        '[class*="animate-spin"], [class*="loading"], [class*="spinner"], [class*="skeleton"], [class*="cursor-blink"], [class*="typing-indicator"]'
      )
    ) {
      return true;
    }

    const boxes = getAssistantMdBoxes();
    if (boxes.length === 0) return false;
    const last = boxes[boxes.length - 1];
    const text = (last.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length > 0 && text.length < 280) {
      if (
        /^(正在|开始|继续).{0,12}(加载|搜索|读取|调用|生成|思考|处理|执行|检索)/.test(text) ||
        /(加载技能|正在读|正在查|Searching|Loading skill|Reading transcript)/i.test(text)
      ) {
        return true;
      }
    }
    const parent = last.closest('[class*="flex"]');
    if (parent && parent.querySelector('[class*="loading"], [class*="spinner"], [class*="animate-spin"]')) {
      return true;
    }

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

    // Phase 2: Wait until text is stable AND the page is truly idle.
    // Tool/Feishu pauses often leave text unchanged while send stays disabled —
    // those must NOT count as completion.
    console.log("[DA] Waiting for response to stabilize...");
    const STABLE_NEEDED = 6;       // ~3s unchanged text while idle
    const IDLE_AFTER_BUSY = 8;     // ~4s idle after last busy/tool pause
    let lastText = "";
    let stableChecks = 0;
    let idleSinceBusy = 0;
    let sawBusy = false;

    while (Date.now() < deadline) {
      scrollToBottom();
      const currentText = getLastAssistantText() || "";
      const busy = isStillStreaming();

      if (busy) {
        sawBusy = true;
        stableChecks = 0;
        idleSinceBusy = 0;
        lastText = currentText;
        await sleep(500);
        continue;
      }

      if (currentText.length > 0 && currentText === lastText) {
        stableChecks++;
        if (sawBusy) idleSinceBusy++;
        if (
          stableChecks >= STABLE_NEEDED &&
          (!sawBusy || idleSinceBusy >= IDLE_AFTER_BUSY)
        ) {
          console.log("[DA] Response stabilized (idle after busy)");
          break;
        }
      } else {
        stableChecks = 0;
        idleSinceBusy = 0;
        lastText = currentText;
      }

      await sleep(500);
    }

    while (Date.now() < deadline && isStillStreaming()) {
      await sleep(500);
    }
    if (isStillStreaming()) {
      throw new Error(`Timeout: page still busy after ${timeoutSec}s`);
    }

    // Phase 3: Extract final text
    await sleep(400);
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
