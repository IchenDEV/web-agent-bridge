import type { ElementHandle, Page } from "playwright";
import { asElement, pollForResponse, type BrowserAdapter } from "./base.js";

const INPUT = [
  '[role="textbox"][contenteditable="true"]',
  '[contenteditable="true"]',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="Search"]',
  'textarea',
].join(", ");

async function snapshot(page: Page): Promise<ElementHandle | null> {
  return asElement(page, () => {
    const answers = [
      ...document.querySelectorAll(
        'div[class*="prose"], [class*="answer"], [data-testid*="answer"]',
      ),
    ].filter((el) => {
      if (el.closest('[contenteditable="true"], form, [role="textbox"]')) return false;
      const t = (el.textContent || "").trim();
      return t.length > 20;
    });
    return answers.length ? answers[answers.length - 1] : null;
  });
}

async function send(page: Page, text: string): Promise<void> {
  await page.waitForSelector(INPUT, { timeout: 20_000 });
  await page.evaluate(async (message) => {
    const input = document.querySelector(
      '[role="textbox"][contenteditable="true"], [contenteditable="true"], textarea[placeholder*="Ask"], textarea[placeholder*="Search"], textarea',
    ) as HTMLElement | null;
    if (!input) throw new Error("Perplexity input not found");
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
      'button[aria-label*="Submit"], button[aria-label*="Ask"], button[aria-label*="Send"], button[type="submit"]',
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

export const perplexityAdapter: BrowserAdapter = {
  name: "perplexity",
  url: "https://www.perplexity.ai/",
  urlPattern: /^https:\/\/(www\.)?perplexity\.ai\//,
  async sendAndWaitForResponse(page, text, timeoutMs = 180_000) {
    const prev = await snapshot(page);
    try {
      await send(page, text);
      return await pollForResponse(page, prev, timeoutMs, {
        label: "perplexity",
        stableChecks: 5,
        idleAfterBusyChecks: 6,
        hasNew: (prevEl) =>
          page.evaluate((prevNode) => {
            const answers = [
              ...document.querySelectorAll(
                'div[class*="prose"], [class*="answer"], [data-testid*="answer"]',
              ),
            ].filter((el) => {
              if (el.closest('[contenteditable="true"], form, [role="textbox"]')) return false;
              return (el.textContent || "").trim().length > 20;
            });
            if (answers.length === 0) return false;
            if (!prevNode) return true;
            const last = answers[answers.length - 1];
            if (last === prevNode) return false;
            if (!(prevNode as Node).isConnected) return true;
            return !!((prevNode as Node).compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING);
          }, prevEl),
        lastText: () =>
          page.evaluate(() => {
            const answers = [
              ...document.querySelectorAll(
                'div[class*="prose"], [class*="answer"], [data-testid*="answer"]',
              ),
            ].filter((el) => {
              if (el.closest('[contenteditable="true"], form, [role="textbox"]')) return false;
              return (el.textContent || "").trim().length > 20;
            });
            const last = answers[answers.length - 1];
            if (!last) return null;
            const value = (last.textContent || "").replace(/\s+/g, " ").trim();
            return value || null;
          }),
        isStreaming: () =>
          page.evaluate(() => {
            for (const btn of document.querySelectorAll("button")) {
              const label = `${btn.getAttribute("aria-label") || ""} ${(btn.textContent || "").trim()}`;
              if (/^(Stop|Stop generating|停止)$/i.test(label.trim())) {
                const r = btn.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return true;
              }
            }
            if (
              document.querySelector(
                '[class*="animate-spin"], [class*="loading"], [class*="skeleton"], [aria-busy="true"]',
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
