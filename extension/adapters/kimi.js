/**
 * Kimi (月之暗面) DOM Adapter
 *
 * Selectors from community automation + moonshot testids.
 *
 * DOM structure (approx.):
 *   [data-testid="msh-chatinput-editor"] / Lexical textbox — input
 *   Enter / Submit                                        — send
 *   [data-testid*="chat-segment"] / markdown / content___* — assistant
 */

const KimiAdapter = (() => {
  const INPUT_SELECTORS = [
    '[data-testid="msh-chatinput-editor"]',
    '[data-testid="chat-input"][contenteditable="true"]',
    '[role="textbox"][contenteditable="true"]',
    'textarea[name="message"]',
    'div[contenteditable="true"]',
    "textarea",
  ].join(", ");

  const SEND_SELECTORS = [
    'button[aria-label="Submit"]',
    'button[aria-label*="发送"]',
    'button[type="submit"]',
    'button[data-testid*="send"]',
  ].join(", ");

  function findInput() {
    return document.querySelector(INPUT_SELECTORS);
  }

  function findSendButton() {
    return document.querySelector(SEND_SELECTORS);
  }

  function getAnswers() {
    return [...document.querySelectorAll(".chat-content-item-assistant, .segment-assistant")];
  }

  function cleanText(raw) {
    return raw.replace(/\s+/g, " ").trim();
  }

  function extractText(el) {
    const mds = [...el.querySelectorAll(".markdown")].filter((m) => !m.closest(".toolcall-content"));
    const pick = mds.length ? mds[mds.length - 1] : el.querySelector(".markdown") || el;
    let value = cleanText(pick.textContent || "");
    for (const noise of ["编辑", "复制", "分享"]) {
      value = value.replace(new RegExp(noise, "g"), "").trim();
    }
    return value;
  }

  function getLastAssistantText() {
    const answers = getAnswers();
    if (answers.length === 0) return null;
    return extractText(answers[answers.length - 1]) || null;
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
    throw new Error(`Kimi input not found within ${timeoutMs / 1000}s. URL: ${location.href}`);
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
      input.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
      );
    }

    await sleep(400);
    const sendBtn = findSendButton();
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
      throw new Error(`Timeout: no new Kimi message after ${timeoutSec}s`);
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
    if (!responseText) throw new Error("Could not extract Kimi response text");
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
