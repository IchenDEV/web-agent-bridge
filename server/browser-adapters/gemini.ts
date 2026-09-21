import type { ElementHandle, Page } from "playwright";
import { asElement, pollForResponse, type BrowserAdapter } from "./base.js";

const INPUT = [
  '.ql-editor[contenteditable="true"]',
  'rich-textarea [contenteditable="true"]',
  '[aria-label*="prompt"][contenteditable]',
  'div[role="textbox"][contenteditable]',
].join(", ");

async function snapshot(page: Page): Promise<ElementHandle | null> {
  return asElement(page, () => {
    const list = document.querySelectorAll("model-response");
    return list.length ? list.item(list.length - 1) : null;
  });
}

async function send(page: Page, text: string): Promise<void> {
  await page.waitForSelector(INPUT, { timeout: 20_000 });
  await page.evaluate(async (message) => {
    const input = document.querySelector(
      '.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"], [aria-label*="prompt"][contenteditable], div[role="textbox"][contenteditable]',
    ) as HTMLElement | null;
    if (!input) throw new Error("Gemini input not found");
    input.focus();
    await new Promise((r) => setTimeout(r, 150));
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
    await new Promise((r) => setTimeout(r, 400));
    const sendBtn = document.querySelector(
      'button[aria-label="Send message"], .send-button button, gem-icon-button.send-button button',
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

export const geminiAdapter: BrowserAdapter = {
  name: "gemini",
  url: "https://gemini.google.com/app",
  urlPattern: /^https:\/\/gemini\.google\.com\//,
  async sendAndWaitForResponse(page, text, timeoutMs = 120_000) {
    const prev = await snapshot(page);
    try {
      await send(page, text);
      return await pollForResponse(page, prev, timeoutMs, {
        label: "gemini",
        hasNew: (prevEl) =>
          page.evaluate((prevNode) => {
            const responses = [...document.querySelectorAll("model-response")];
            if (responses.length === 0) return false;
            if (!prevNode) return true;
            const last = responses[responses.length - 1];
            if (last === prevNode) return false;
            if (!(prevNode as Node).isConnected) return true;
            return !!((prevNode as Node).compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING);
          }, prevEl),
        lastText: () =>
          page.evaluate(() => {
            const responses = [...document.querySelectorAll("model-response")];
            const last = responses[responses.length - 1];
            if (!last) return null;
            const md = last.querySelector("message-content .markdown, message-content");
            const value = ((md ?? last).textContent || "").replace(/\s+/g, " ").trim();
            return value || null;
          }),
        isStreaming: () =>
          page.evaluate(() => {
            const stopBtn = document.querySelector(
              'button[aria-label="Stop response"], button[aria-label="Stop generating"]',
            ) as HTMLElement | null;
            if (stopBtn && stopBtn.offsetParent !== null) return true;
            return !!document.querySelector(
              '[class*="loading-animation"], [class*="generating"], [class*="response-streaming"]',
            );
          }),
      });
    } finally {
      await prev?.dispose();
    }
  },
};
