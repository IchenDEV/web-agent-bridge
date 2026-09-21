import type { ElementHandle, Page } from "playwright";
import { asElement, pollForResponse, type BrowserAdapter } from "./base.js";

const INPUT = [
  "#prompt-textarea",
  '[data-testid="prompt-textarea"]',
  '[contenteditable="true"][data-lexical-editor="true"]',
  'div[placeholder*="Message"][contenteditable]',
].join(", ");

async function snapshot(page: Page): Promise<ElementHandle | null> {
  return asElement(page, () => {
    const turns = [
      ...document.querySelectorAll(
        '[data-message-author-role="assistant"], [data-testid^="conversation-turn-"][data-turn="assistant"]',
      ),
    ];
    return turns.length ? turns[turns.length - 1] : null;
  });
}

async function send(page: Page, text: string): Promise<void> {
  await page.waitForSelector(INPUT, { timeout: 20_000 });
  await page.evaluate(async (message) => {
    const input = document.querySelector(
      '#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"][data-lexical-editor="true"], div[placeholder*="Message"][contenteditable]',
    ) as HTMLElement | null;
    if (!input) throw new Error("ChatGPT input not found");
    input.focus();
    await new Promise((r) => setTimeout(r, 150));
    if (input instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      setter?.call(input, message);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.execCommand("selectAll", false);
      document.execCommand("delete", false);
      await new Promise((r) => setTimeout(r, 100));
      if (input.textContent?.trim()) {
        input.textContent = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 100));
      }
      document.execCommand("insertText", false, message);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 400));
    const sendBtn = document.querySelector(
      'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"]',
    ) as HTMLElement | null;
    if (sendBtn) sendBtn.click();
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
  }, text);
}

export const chatgptAdapter: BrowserAdapter = {
  name: "chatgpt",
  url: "https://chatgpt.com/",
  urlPattern: /^https:\/\/chatgpt\.com\//,
  async sendAndWaitForResponse(page, text, timeoutMs = 120_000) {
    const prev = await snapshot(page);
    try {
      await send(page, text);
      return await pollForResponse(page, prev, timeoutMs, {
        label: "chatgpt",
        hasNew: (prevEl) =>
          page.evaluate((prevNode) => {
            const turns = [
              ...document.querySelectorAll(
                '[data-message-author-role="assistant"], [data-testid^="conversation-turn-"][data-turn="assistant"]',
              ),
            ];
            if (turns.length === 0) return false;
            if (!prevNode) return true;
            const last = turns[turns.length - 1];
            if (last === prevNode) return false;
            if (!(prevNode as Node).isConnected) return true;
            return !!((prevNode as Node).compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING);
          }, prevEl),
        lastText: () =>
          page.evaluate(() => {
            const turns = [
              ...document.querySelectorAll(
                '[data-message-author-role="assistant"], [data-testid^="conversation-turn-"][data-turn="assistant"]',
              ),
            ];
            const last = turns[turns.length - 1];
            if (!last) return null;
            const md = last.querySelector('.markdown.prose, .markdown, [class*="markdown"]');
            const value = ((md ?? last).textContent || "").replace(/\s+/g, " ").trim();
            return value || null;
          }),
        isStreaming: () =>
          page.evaluate(() => {
            if (
              document.querySelector(
                '[class*="result-streaming"], [class*="thinking"], [data-testid="loading"]',
              )
            ) {
              return true;
            }
            return !!document.querySelector(
              'button[aria-label="Stop generating"], button[data-testid="stop-button"]',
            );
          }),
      });
    } finally {
      await prev?.dispose();
    }
  },
};
