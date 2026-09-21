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

export const doubaoAdapter: BrowserAdapter = {
  name: "doubao",
  url: "https://www.doubao.com/chat/",
  urlPattern: /^https:\/\/www\.doubao\.com\/chat/,
  async sendAndWaitForResponse(page, text, timeoutMs = 120_000) {
    const prev = await snapshot(page);
    try {
      await send(page, text);
      return await pollForResponse(page, prev, timeoutMs, {
        label: "doubao",
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
        isStreaming: () =>
          page.evaluate(() => {
            if (document.querySelector('[class*="cursor-blink"], [class*="typing-indicator"]')) {
              return true;
            }
            const boxes = [...document.querySelectorAll(".md-box-root")].filter(
              (el) => !el.closest('[class*="send-msg-bubble"]'),
            );
            const last = boxes[boxes.length - 1];
            const parent = last?.closest('[class*="flex"]');
            return !!(parent && parent.querySelector('[class*="loading"], [class*="spinner"]'));
          }),
      });
    } finally {
      await prev?.dispose();
    }
  },
};
