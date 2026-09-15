/**
 * Doubao (豆包) DOM Adapter
 *
 * Handles sending messages to and reading responses from the Doubao web chat.
 * Selectors based on OpenCLI / Uni-CLI verified patterns (2026-06).
 */

const DoubaoAdapter = (() => {

  // ── Selectors ──

  const SELECTORS = {
    // Input field: contenteditable div or textarea
    input: [
      '[contenteditable="true"]',
      'textarea[data-testid="chat_input"]',
      '.chat-input textarea',
      'textarea',
    ].join(", "),

    // Send button
    sendButton: [
      '[data-testid="chat_input_send"]',
      'button[class*="send"]',
    ].join(", "),

    // Message content elements
    messageContent: [
      '[data-testid="message_text_content"]',
      '.md-box-root',
      '.flow-markdown-body',
    ].join(", "),

    // Assistant message bubble wrapper
    assistantBubble: '[class*="bg-g-receive-msg-bubble"]',

    // Streaming cursor (present while AI is still typing)
    streamingCursor: '[class*="cursor"]',

    // Message list container
    messageList: [
      '[class*="message-list"]',
      '.container-PvPoAn',
      '.scroll-view-OEiNXD',
      '[data-testid="message-list"]',
    ].join(", "),
  };

  // UI noise text to filter out
  const NOISE_PATTERNS = [
    "内容由豆包 AI 生成，请仔细甄别",
    "请仔细甄别",
    "下载电脑版",
  ];

  // ── DOM helpers ──

  function findInput() {
    return document.querySelector(SELECTORS.input);
  }

  function findSendButton() {
    return document.querySelector(SELECTORS.sendButton);
  }

  function getAllMessageContents() {
    return [...document.querySelectorAll(SELECTORS.messageContent)];
  }

  function getLastAssistantText() {
    const msgs = getAllMessageContents();
    if (msgs.length === 0) return null;

    // Walk backwards to find the last assistant message
    for (let i = msgs.length - 1; i >= 0; i--) {
      const el = msgs[i];
      // Check if this message is inside an assistant bubble
      const bubble = el.closest(SELECTORS.assistantBubble);
      if (bubble || i === msgs.length - 1) {
        const text = cleanText(el.textContent || "");
        if (text) return text;
      }
    }
    return null;
  }

  function isStillStreaming() {
    const msgs = getAllMessageContents();
    if (msgs.length === 0) return false;
    const last = msgs[msgs.length - 1];
    return !!last.querySelector(SELECTORS.streamingCursor);
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

    editor.focus();
    await sleep(100);

    if (editor.tagName === "TEXTAREA") {
      // For textarea elements
      editor.value = text;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      // For contenteditable elements
      // Clear existing content
      editor.textContent = "";
      document.execCommand("insertText", false, text);
    }

    await sleep(300);

    // Try clicking the send button, fall back to Enter key
    const sendBtn = findSendButton();
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
    } else {
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
        })
      );
    }

    console.log("[DoubaoAdapter] Message sent");
  }

  // ── Wait for AI response ──

  async function waitForResponse(prevCount, timeoutSec = 90) {
    const deadline = Date.now() + timeoutSec * 1000;

    // Phase 1: Wait for a new message to appear
    while (Date.now() < deadline) {
      const currentCount = getAllMessageContents().length;
      if (currentCount > prevCount) break;
      await sleep(500);
    }

    if (getAllMessageContents().length <= prevCount) {
      throw new Error("Timeout: no new assistant message appeared");
    }

    // Phase 2: Wait for streaming to finish
    while (Date.now() < deadline) {
      if (!isStillStreaming()) break;
      await sleep(500);
    }

    // Phase 3: Small extra wait for DOM to settle
    await sleep(500);

    const text = getLastAssistantText();
    if (!text) throw new Error("Could not extract assistant response text");
    return text;
  }

  // ── Public API ──

  async function sendAndWaitForResponse(text, timeoutSec = 90) {
    const prevCount = getAllMessageContents().length;
    await sendMessage(text);
    return waitForResponse(prevCount, timeoutSec);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  return { sendMessage, waitForResponse, sendAndWaitForResponse };
})();
