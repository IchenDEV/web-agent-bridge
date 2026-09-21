import type { ElementHandle, Page } from "playwright";
import { asElement, pollForResponse, type BrowserAdapter } from "./base.js";

const INPUT = '[contenteditable="true"]';

async function snapshot(page: Page): Promise<ElementHandle | null> {
  return asElement(page, () => {
    const boxes = [...document.querySelectorAll(".md-box-root")].filter(
      (el) => !el.closest('[class*="send-msg-bubble"]'),
    );
    return boxes.length ? boxes[boxes.length - 1] : null;
  });
}

/**
 * IMPORTANT: callbacks passed to page.evaluate must not declare named inner
 * functions (e.g. `const sleep = ...`). tsx rewrites those to `__name(...)`,
 * which then fails inside the browser.
 */
async function send(page: Page, text: string): Promise<void> {
  await page.waitForSelector(INPUT, { timeout: 20_000 });
  await page.evaluate(async (message) => {
    const editor = document.querySelector('[contenteditable="true"]') as HTMLElement | null;
    if (!editor) throw new Error("Doubao chat input not found");
    editor.focus();
    await new Promise((r) => setTimeout(r, 150));
    document.execCommand("selectAll", false);
    document.execCommand("delete", false);
    await new Promise((r) => setTimeout(r, 100));
    if (editor.textContent?.trim()) {
      editor.textContent = "";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand("insertText", false, message);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const sendBtn = document.querySelector(".send-btn-wrapper button") as HTMLElement | null;
    if (sendBtn) sendBtn.click();
    else {
      editor.dispatchEvent(
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
  }, text);
}

/**
 * True while Doubao is still working — including tool/Feishu pauses where the
 * assistant text is temporarily unchanged.
 *
 * Live signals observed on doubao.com:
 *   - `.send-btn-wrapper button[disabled]` / class `send-msg-btn-di…` while generating
 *   - animate-spin / loading / spinner / skeleton nodes in the chat surface
 *   - short status lines like “正在加载技能 / 正在搜索 / 正在读取…”
 */
function isDoubaoBusy(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const sendBtn = document.querySelector(".send-btn-wrapper button") as HTMLButtonElement | null;
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
        '[class*="animate-spin"], [class*="loading"], [class*="spinner"], [class*="skeleton"], [class*="cursor-blink"], [class*="typing-indicator"]',
      )
    ) {
      return true;
    }

    const boxes = [...document.querySelectorAll(".md-box-root")].filter(
      (el) => !el.closest('[class*="send-msg-bubble"]'),
    );
    const last = boxes[boxes.length - 1];
    if (last) {
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
    }

    return false;
  });
}

export const doubaoAdapter: BrowserAdapter = {
  name: "doubao",
  url: "https://www.doubao.com/chat/",
  urlPattern: /^https:\/\/www\.doubao\.com\/chat/,
  async sendAndWaitForResponse(page, text, timeoutMs = 300_000) {
    const prev = await snapshot(page);
    try {
      await send(page, text);
      return await pollForResponse(page, prev, timeoutMs, {
        label: "doubao",
        intervalMs: 500,
        // ~3s of unchanged text while idle…
        stableChecks: 6,
        // …and ~4s idle after the last busy/tool pause (send disabled, etc.).
        idleAfterBusyChecks: 8,
        hasNew: (prevEl) =>
          page.evaluate((prevNode) => {
            const boxes = [...document.querySelectorAll(".md-box-root")].filter(
              (el) => !el.closest('[class*="send-msg-bubble"]'),
            );
            if (boxes.length === 0) return false;
            if (!prevNode) return true;
            const last = boxes[boxes.length - 1];
            if (last === prevNode) return false;
            if (!(prevNode as Node).isConnected) return true;
            return !!((prevNode as Node).compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING);
          }, prevEl),
        lastText: () =>
          page.evaluate(() => {
            const boxes = [...document.querySelectorAll(".md-box-root")].filter(
              (el) => !el.closest('[class*="send-msg-bubble"]'),
            );
            const last = boxes[boxes.length - 1];
            if (!last) return null;
            let value = (last.textContent || "").replace(/\s+/g, " ").trim();
            for (const noise of [
              "内容由豆包 AI 生成，请仔细甄别",
              "请仔细甄别",
              "下载电脑版",
              "内容由 AI 生成",
            ]) {
              value = value.replace(noise, "").trim();
            }
            return value || null;
          }),
        isStreaming: () => isDoubaoBusy(page),
      });
    } finally {
      await prev?.dispose();
    }
  },
};
