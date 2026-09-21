import type { ElementHandle, Page } from "playwright";
import { asElement, pollForResponse, type BrowserAdapter } from "./base.js";

async function snapshot(page: Page): Promise<ElementHandle | null> {
  return asElement(page, () => {
    const feedbacks = [...document.querySelectorAll('[class*="assistantFeedback"]')];
    if (feedbacks.length > 0) return feedbacks[feedbacks.length - 1].parentElement ?? null;
    const chat = document.querySelector(".chat-container");
    if (!chat) return null;
    const blocks = [
      ...chat.querySelectorAll('[class*="markdown"], [class*="md-render"], [class*="rich-text"], .prose'),
    ];
    return blocks.length ? blocks[blocks.length - 1] : null;
  });
}

async function send(page: Page, text: string): Promise<void> {
  await page.waitForSelector('div[role="textbox"][contenteditable="true"]', { timeout: 20_000 });
  await page.evaluate(async (message) => {
    const editor = document.querySelector(
      'div[role="textbox"][contenteditable="true"]',
    ) as HTMLElement | null;
    if (!editor) throw new Error("WorkBuddy chat input not found");
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
    await new Promise((r) => setTimeout(r, 500));
    const sendBtn = (document.querySelector('[data-track-id="agent_session_input_status"]') ||
      document.querySelector('._icon_981i8_1[role="button"]')) as HTMLElement | null;
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

export const workbuddyAdapter: BrowserAdapter = {
  name: "workbuddy",
  url: "https://www.workbuddy.cn/app",
  urlPattern: /^https:\/\/www\.workbuddy\.cn\/app/,
  async sendAndWaitForResponse(page, text, timeoutMs = 180_000) {
    const prev = await snapshot(page);
    try {
      await send(page, text);
      return await pollForResponse(page, prev, timeoutMs, {
        label: "workbuddy",
        intervalMs: 800,
        stableChecks: 4,
        hasNew: (prevEl) =>
          page.evaluate((prevNode) => {
            const blocks: Element[] = [];
            const feedbacks = document.querySelectorAll('[class*="assistantFeedback"]');
            if (feedbacks.length > 0) {
              for (const fb of feedbacks) {
                if (fb.parentElement) blocks.push(fb.parentElement);
              }
            } else {
              const found =
                document.querySelector(".chat-container")?.querySelectorAll(
                  '[class*="markdown"], [class*="md-render"], [class*="rich-text"], .prose',
                ) ?? [];
              for (const el of found) blocks.push(el);
            }
            if (blocks.length === 0) return false;
            if (!prevNode) return true;
            const last = blocks[blocks.length - 1];
            if (!last || last === prevNode) return false;
            if (!(prevNode as Node).isConnected) return true;
            return !!((prevNode as Node).compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING);
          }, prevEl),
        lastText: () =>
          page.evaluate(() => {
            const blocks: Element[] = [];
            const feedbacks = document.querySelectorAll('[class*="assistantFeedback"]');
            if (feedbacks.length > 0) {
              for (const fb of feedbacks) {
                if (fb.parentElement) blocks.push(fb.parentElement);
              }
            } else {
              const found =
                document.querySelector(".chat-container")?.querySelectorAll(
                  '[class*="markdown"], [class*="md-render"], [class*="rich-text"], .prose',
                ) ?? [];
              for (const el of found) blocks.push(el);
            }
            const last = blocks[blocks.length - 1];
            if (!last) return null;
            let value = (last.textContent || "").replace(/\s+/g, " ").trim();
            for (const noise of ["内容由 AI 生成", "以上内容仅供参考", "此内容由 AI 模型生成", "复制回答内容"]) {
              value = value.replace(noise, "").trim();
            }
            return value || null;
          }),
        isStreaming: () =>
          page.evaluate(() => {
            for (const btn of document.querySelectorAll("button")) {
              const label = (btn.textContent || "").trim();
              if (label === "Stop" || label === "停止" || label === "停止生成") return true;
              if (btn.getAttribute("data-track-id") === "agent_session_input_status") {
                const state = btn.getAttribute("data-state");
                if (state === "generating" || state === "streaming") return true;
              }
            }
            const loading = document.querySelector(
              '[class*="cursor-blink"], [class*="typing-indicator"], [class*="generating"], [class*="thinking"], [class*="spinner"], [class*="step-running"]',
            ) as HTMLElement | null;
            return !!(loading && loading.offsetParent !== null);
          }),
      });
    } finally {
      await prev?.dispose();
    }
  },
};
