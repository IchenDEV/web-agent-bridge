import type { ElementHandle, Page } from "playwright";
import { asElement, pollForResponse, type BrowserAdapter } from "./base.js";

const INPUT = [
  '[data-testid="msh-chatinput-editor"]',
  '[data-testid="chat-input"][contenteditable="true"]',
  '[role="textbox"][contenteditable="true"]',
  'textarea[name="message"]',
  'div[contenteditable="true"]',
  "textarea",
].join(", ");

async function snapshot(page: Page): Promise<ElementHandle | null> {
  return asElement(page, () => {
    const nodes = [
      ...document.querySelectorAll(
        '[data-testid*="chat-segment"], [class*="markdown"], [class*="content___"], .markdown',
      ),
    ].filter((el) => {
      if (el.closest('[contenteditable="true"], [data-testid="msh-chatinput-editor"], form')) {
        return false;
      }
      return (el.textContent || "").trim().length > 8;
    });
    return nodes.length ? nodes[nodes.length - 1] : null;
  });
}

async function send(page: Page, text: string): Promise<void> {
  await page.waitForSelector(INPUT, { timeout: 20_000 });
  await page.evaluate(async (message) => {
    const input = document.querySelector(
      '[data-testid="msh-chatinput-editor"], [data-testid="chat-input"][contenteditable="true"], [role="textbox"][contenteditable="true"], textarea[name="message"], div[contenteditable="true"], textarea',
    ) as HTMLElement | null;
    if (!input) throw new Error("Kimi input not found");
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
      input.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: message }),
      );
    }
    await new Promise((r) => setTimeout(r, 400));
    const sendBtn = document.querySelector(
      'button[aria-label="Submit"], button[aria-label*="发送"], button[type="submit"], button[data-testid*="send"]',
    ) as HTMLButtonElement | null;
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
  }, text);
}

export const kimiAdapter: BrowserAdapter = {
  name: "kimi",
  url: "https://www.kimi.com/",
  urlPattern: /^https:\/\/(www\.)?(kimi\.com|kimi\.moonshot\.cn)\//,
  async sendAndWaitForResponse(page, text, timeoutMs = 180_000) {
    const prev = await snapshot(page);
    try {
      await send(page, text);
      return await pollForResponse(page, prev, timeoutMs, {
        label: "kimi",
        stableChecks: 5,
        idleAfterBusyChecks: 6,
        hasNew: (prevEl) =>
          page.evaluate((prevNode) => {
            const nodes = [
              ...document.querySelectorAll(
                '[data-testid*="chat-segment"], [class*="markdown"], [class*="content___"], .markdown',
              ),
            ].filter((el) => {
              if (el.closest('[contenteditable="true"], [data-testid="msh-chatinput-editor"], form')) {
                return false;
              }
              return (el.textContent || "").trim().length > 8;
            });
            if (nodes.length === 0) return false;
            if (!prevNode) return true;
            const last = nodes[nodes.length - 1];
            if (last === prevNode) return false;
            if (!(prevNode as Node).isConnected) return true;
            return !!((prevNode as Node).compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING);
          }, prevEl),
        lastText: () =>
          page.evaluate(() => {
            const nodes = [
              ...document.querySelectorAll(
                '[data-testid*="chat-segment"], [class*="markdown"], [class*="content___"], .markdown',
              ),
            ].filter((el) => {
              if (el.closest('[contenteditable="true"], [data-testid="msh-chatinput-editor"], form')) {
                return false;
              }
              return (el.textContent || "").trim().length > 8;
            });
            const last = nodes[nodes.length - 1];
            if (!last) return null;
            return (last.textContent || "").replace(/\s+/g, " ").trim() || null;
          }),
        isStreaming: () =>
          page.evaluate(() => {
            for (const btn of document.querySelectorAll("button")) {
              const label = `${btn.getAttribute("aria-label") || ""} ${(btn.textContent || "").trim()}`;
              if (/^(停止|停止生成|Stop|Stop generating)$/i.test(label.trim())) {
                const r = btn.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return true;
              }
            }
            if (
              document.querySelector(
                '[class*="animate-spin"], [class*="loading"], [class*="spinner"], [aria-busy="true"]',
              )
            ) {
              return true;
            }
            return false;
          }),
      });
    } finally {
      await prev?.dispose();
    }
  },
};
