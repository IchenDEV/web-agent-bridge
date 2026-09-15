/**
 * WorkBuddy (workbuddy.cn) DOM Adapter
 *
 * WorkBuddy is Tencent's AI office workspace (task-based, not just chat).
 * Users send natural-language tasks and get structured results.
 *
 * DOM structure (derived from genie-chat-ui bundle + live inspection 2026-09-16):
 *
 *   ._editable_1xsqb_1[role="textbox"]                — contentEditable input
 *   [data-track-id="agent_session_input_status"]       — send button
 *   .chat-container  / ._cbChat_*                      — chat wrapper
 *   [id^="user-message-"]                              — user message element
 *   [class*="_userMessageBubble_"]                      — user bubble
 *   [class*="assistantFeedback"]                        — assistant feedback row
 *
 * Message rendering uses a "MessageTimeline" component.
 * Each request group contains multiple messages (user + assistant).
 * messageType: "user" | "assistant" | "system"
 */

const WorkbuddyAdapter = (() => {

  const SELECTORS = {
    // ContentEditable input editor (Slate-based)
    input: 'div[role="textbox"][contenteditable="true"]',

    // Send button (icon button with tracking data attribute)
    sendButton: '[data-track-id="agent_session_input_status"]',

    // Chat container
    chatContainer: '.chat-container',

    // User message markers (high specificity)
    userMessageById: '[id^="user-message-"]',
    userBubble: '[class*="_userMessageBubble_"]',

    // Assistant feedback bar (appears below each assistant response)
    assistantFeedback: '[class*="assistantFeedback"]',

    // Fallback send button
    sendButtonFallback: '._icon_981i8_1[role="button"]',
  };

  const NOISE_PATTERNS = [
    "内容由 AI 生成",
    "以上内容仅供参考",
    "此内容由 AI 模型生成",
    "复制回答内容",
  ];

  // ── DOM helpers ──

  function findInput() {
    return document.querySelector(SELECTORS.input);
  }

  function findSendButton() {
    return (
      document.querySelector(SELECTORS.sendButton) ||
      document.querySelector(SELECTORS.sendButtonFallback)
    );
  }

  /**
   * Detect user message elements reliably.
   * WorkBuddy renders user messages with id="user-message-{requestId}"
   * and a _userMessageBubble_* class on the bubble wrapper.
   */
  function getUserMessages() {
    const byId = document.querySelectorAll(SELECTORS.userMessageById);
    if (byId.length > 0) return [...byId];
    return [...document.querySelectorAll(SELECTORS.userBubble)];
  }

  /**
   * Find all assistant response blocks.
   *
   * Strategy:
   *  1. Find elements with assistantFeedback class — the sibling/parent
   *     region above it is the assistant content.
   *  2. Look at the MessageTimeline structure — blocks between user
   *     messages that contain markdown/rich content.
   *  3. Generic content blocks inside the chat that are NOT user messages.
   */
  function getAssistantContentBlocks() {
    // Strategy 1: assistantFeedback bars indicate assistant regions
    const feedbacks = document.querySelectorAll(SELECTORS.assistantFeedback);
    if (feedbacks.length > 0) {
      const blocks = [];
      for (const fb of feedbacks) {
        // Walk up to find the message content container
        // The feedback is a sibling of the content in the same message wrapper
        const parent = fb.parentElement;
        if (!parent) continue;
        blocks.push(parent);
      }
      return blocks;
    }

    // Strategy 2: look for blocks in chat that are NOT user messages
    const chat = document.querySelector(SELECTORS.chatContainer);
    if (!chat) return [];

    // Find all content blocks in the chat area
    const allContentBlocks = chat.querySelectorAll(
      '[class*="markdown"], [class*="md-render"], [class*="rich-text"], .prose, [class*="_content_"]'
    );

    const userMsgElements = new Set();
    getUserMessages().forEach(el => {
      let node = el;
      while (node && node !== chat) {
        userMsgElements.add(node);
        node = node.parentElement;
      }
    });

    return [...allContentBlocks].filter(el => {
      let node = el;
      while (node && node !== chat) {
        if (userMsgElements.has(node)) return false;
        node = node.parentElement;
      }
      return true;
    });
  }

  function extractText(el) {
    return cleanText(el.textContent || "");
  }

  function getLastAssistantText() {
    const blocks = getAssistantContentBlocks();
    if (blocks.length === 0) return null;
    const last = blocks[blocks.length - 1];
    const text = extractText(last);
    return text || null;
  }

  /**
   * Check if WorkBuddy is still generating a response.
   */
  function isStillStreaming() {
    // Look for "Stop" button (chatInput.stop)
    const stopBtns = document.querySelectorAll('button');
    for (const btn of stopBtns) {
      const text = btn.textContent?.trim();
      if (text === 'Stop' || text === '停止' || text === '停止生成') return true;
      // Check for stop icon button (square icon in send button position)
      if (btn.getAttribute('data-track-id') === 'agent_session_input_status') {
        const state = btn.getAttribute('data-state');
        if (state === 'generating' || state === 'streaming') return true;
      }
    }

    // Common loading indicators
    const loadingSelectors = [
      '[class*="cursor-blink"]',
      '[class*="typing-indicator"]',
      '[class*="generating"]',
      '[class*="thinking"]',
      '[class*="spinner"]',
      '[class*="step-running"]',
      '[class*="compacting"]',
    ];

    for (const sel of loadingSelectors) {
      const found = document.querySelector(sel);
      if (found && found.offsetParent !== null) return true;
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

  // ── Send a message ──

  async function sendMessage(text) {
    const editor = findInput();
    if (!editor) throw new Error("WorkBuddy chat input not found on page");

    console.log(`[WB] Found editor: ${editor.className.slice(0, 60)}`);

    editor.focus();
    await sleep(200);

    // Select all existing content and replace
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    // WorkBuddy uses Slate editor — insertText via execCommand
    document.execCommand("insertText", false, text);
    editor.dispatchEvent(new Event("input", { bubbles: true }));

    console.log(`[WB] Text inserted: "${editor.textContent?.slice(0, 40)}"`);
    await sleep(500);

    // Click send button
    const sendBtn = findSendButton();
    if (sendBtn) {
      console.log("[WB] Clicking send button");
      sendBtn.click();
    } else {
      console.log("[WB] No send button, trying Enter");
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

    console.log("[WB] Message sent");
  }

  // ── Wait for AI response ──

  async function waitForResponse(prevUserCount, prevAssistantCount, timeoutSec = 180) {
    const deadline = Date.now() + timeoutSec * 1000;
    const startUrl = location.href;
    let navigationDetected = false;

    // Phase 1: Wait for a new assistant response to appear
    console.log(
      `[WB] Waiting... (prev user: ${prevUserCount}, prev assistant: ${prevAssistantCount})`
    );

    while (Date.now() < deadline) {
      // Check for page navigation (task creation → task page)
      if (!navigationDetected && location.href !== startUrl) {
        console.log(`[WB] Navigation: ${startUrl} → ${location.href}`);
        navigationDetected = true;
        await sleep(2000);
      }

      const currentAssistant = getAssistantContentBlocks().length;
      if (currentAssistant > prevAssistantCount) {
        console.log(`[WB] New assistant block! (${prevAssistantCount} → ${currentAssistant})`);
        break;
      }

      await sleep(800);
    }

    if (getAssistantContentBlocks().length <= prevAssistantCount) {
      throw new Error(
        `Timeout: no new assistant message after ${timeoutSec}s. ` +
          `User msgs: ${getUserMessages().length}, ` +
          `Assistant blocks: ${getAssistantContentBlocks().length}, ` +
          `URL: ${location.href}`
      );
    }

    // Phase 2: Wait for content to stabilize
    console.log("[WB] Waiting for response to stabilize...");
    let lastText = "";
    let stableChecks = 0;
    const STABLE_THRESHOLD = 4;

    while (Date.now() < deadline) {
      const currentText = getLastAssistantText() || "";

      if (currentText.length > 0 && currentText === lastText && !isStillStreaming()) {
        stableChecks++;
        if (stableChecks >= STABLE_THRESHOLD) {
          console.log("[WB] Response stabilized");
          break;
        }
      } else {
        stableChecks = 0;
        lastText = currentText;
      }

      await sleep(800);
    }

    // Phase 3: Extract final text
    await sleep(500);
    const responseText = getLastAssistantText();

    if (!responseText) {
      throw new Error("Could not extract WorkBuddy response text");
    }

    console.log(`[WB] ✓ Response (${responseText.length} chars): "${responseText.slice(0, 100)}"`);
    return responseText;
  }

  // ── Public API ──

  async function sendAndWaitForResponse(text, timeoutSec = 180) {
    const prevUserCount = getUserMessages().length;
    const prevAssistantCount = getAssistantContentBlocks().length;
    console.log(
      `[WB] Start — user msgs: ${prevUserCount}, assistant blocks: ${prevAssistantCount}`
    );

    await sendMessage(text);
    return waitForResponse(prevUserCount, prevAssistantCount, timeoutSec);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  return { sendMessage, waitForResponse, sendAndWaitForResponse };
})();
