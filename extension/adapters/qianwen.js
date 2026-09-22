/**
 * 通义千问 (Qianwen / Qwen) DOM Adapter
 *
 * Covers www.qianwen.com and chat.qwen.ai variants.
 *
 * DOM structure (approx.):
 *   #chat-input / textarea.message-input-textarea / contenteditable textbox — input
 *   button[aria-label="发送消息"] / .message-input-right-button-send          — send
 *   [data-msgid$="-answer"] / .response-message-content / #qk-markdown-react — answer
 */

const QianwenAdapter = (() => {
  const INPUT_SELECTORS = [
    '[role="textbox"][contenteditable="true"]',
    "#chat-input",
    "textarea.text-area-box-web",
    "textarea.message-input-textarea",
    '[contenteditable="true"]',
    "textarea",
  ].join(", ");

  const SEND_SELECTORS = [
    'button[aria-label="发送消息"]',
    ".message-input-right-button-send",
    ".chat-prompt-send-button .send-button",
    'button[aria-label*="发送"]',
  ].join(", ");

  function findInput() {
    return document.querySelector(INPUT_SELECTORS);
  }

  function findSendButton() {
    return document.querySelector(SEND_SELECTORS);
  }

  function getAnswers() {
    return [
      ...document.querySelectorAll(
        '.chat-answers-card-wrap, .answer-common-card, .qk-markdown-react, .markdown-pc-special-class, [class*="message-select-wrapper-answer"], [data-msgid$="-answer"], [data-chat-answers-wrap], .qwen-chat-message-assistant, .response-message-content.phase-answer, [class*="response-message"]',
      ),
    ].filter((el) => {
      if (el.closest('[contenteditable="true"], [role="textbox"]')) return false;
      return (el.textContent || "").trim().length > 0;
    });
  }

  function cleanText(raw) {
    return raw.replace(/\s+/g, " ").trim();
  }

  function extractText(el) {
    const md =
      el.querySelector('#qk-markdown-react, [class*="markdown"], .response-message-content') || el;
    return cleanText(md.textContent || "");
  }

  function getLastAssistantText() {
    const answers = getAnswers();
    if (answers.length === 0) return null;
    return extractText(answers[answers.length - 1]);
  }

  function snapshotLastAssistant() {
    const answers = getAnswers();
    return answers.length > 0 ? answers[answers.length - 1] : null;
  }

  function hasNewAssistantAfter(prevLastEl) {
    const answers = getAnswers();
    if (answers.length === 0) return false;
    if (!prevLastEl) return answers.length > 0;
    const lastNow = answers[answers.length - 1];
    if (lastNow === prevLastEl) return false;
    if (!document.contains(prevLastEl)) return true;
    return !!(prevLastEl.compareDocumentPosition(lastNow) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function isStillStreaming() {
    for (const btn of document.querySelectorAll("button")) {
      const label = `${btn.getAttribute("aria-label") || ""} ${(btn.textContent || "").trim()}`;
      if (/^(停止|停止生成|Stop|Stop generating)$/i.test(label.trim())) {
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
    }
    if (document.querySelector(".chat-prompt-send-button .stop-button")) return true;
    return !!document.querySelector(
      '[class*="animate-spin"], [class*="loading"], [class*="spinner"], [aria-busy="true"]',
    );
  }

  function scrollToBottom() {
    for (const c of document.querySelectorAll('[class*="scroll"], [class*="chat"], main')) {
      if (c.scrollHeight > c.clientHeight + 50) c.scrollTop = c.scrollHeight;
    }
  }

  async function waitForInput(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = findInput();
      if (el) return el;
      await sleep(500);
    }
    throw new Error(`Qianwen input not found within ${timeoutMs / 1000}s. URL: ${location.href}`);
  }

  async function sendMessage(text) {
    const input = await waitForInput();
    input.focus();
    await sleep(150);

    if (input.tagName === "TEXTAREA") {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(100);
        nativeSetter.call(input, text);
      } else {
        input.value = text;
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
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

    await sleep(400);
    const deadline = Date.now() + 5000;
    let sendBtn = null;
    while (Date.now() < deadline) {
      sendBtn = findSendButton();
      if (sendBtn && !sendBtn.disabled) break;
      await sleep(150);
    }
    if (sendBtn && !sendBtn.disabled) sendBtn.click();
    else {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }

  async function waitForResponse(prevLastEl, timeoutSec = 120) {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      scrollToBottom();
      if (hasNewAssistantAfter(prevLastEl)) break;
      await sleep(500);
    }
    if (!hasNewAssistantAfter(prevLastEl)) {
      throw new Error(`Timeout: no new Qianwen message after ${timeoutSec}s`);
    }

    let lastText = "";
    let stableChecks = 0;
    while (Date.now() < deadline) {
      scrollToBottom();
      const currentText = getLastAssistantText() || "";
      if (currentText.length > 0 && currentText === lastText && !isStillStreaming()) {
        stableChecks++;
        if (stableChecks >= 5) break;
      } else {
        stableChecks = 0;
        lastText = currentText;
      }
      await sleep(500);
    }

    await sleep(300);
    const responseText = getLastAssistantText();
    if (!responseText) throw new Error("Could not extract Qianwen response text");
    return responseText;
  }

  async function sendAndWaitForResponse(text, timeoutSec = 120) {
    const prevLastEl = snapshotLastAssistant();
    await sendMessage(text);
    return waitForResponse(prevLastEl, timeoutSec);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  return { sendMessage, waitForResponse, sendAndWaitForResponse };
})();
