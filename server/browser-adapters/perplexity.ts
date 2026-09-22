import type { Page } from "playwright";
import { pollForResponse, type BrowserAdapter } from "./base.js";

const INPUT = [
  '[role="textbox"][contenteditable="true"]',
  '[contenteditable="true"]',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="Search"]',
  "textarea",
].join(", ");

async function send(page: Page, text: string): Promise<void> {
  await page.waitForSelector(INPUT, { timeout: 20_000 });
  const box = page.locator('[role="textbox"][contenteditable="true"], [contenteditable="true"]').first();
  await box.click({ timeout: 10_000 });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text, { delay: 12 });
  await page.waitForTimeout(400);

  const sendBtn = page.locator(
    'button[aria-label*="Submit"], button[aria-label*="Ask"], button[aria-label*="Send"]',
  ).first();
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const disabled = await sendBtn.isDisabled().catch(() => true);
      if (!disabled) {
        await sendBtn.click();
        return;
      }
      await page.waitForTimeout(150);
    }
  } catch {
    /* Enter fallback */
  }
  await page.keyboard.press("Enter");
}

export const perplexityAdapter: BrowserAdapter = {
  name: "perplexity",
  url: "https://www.perplexity.ai/",
  urlPattern: /^https:\/\/(www\.)?perplexity\.ai\//,
  async sendAndWaitForResponse(page, text, timeoutMs = 180_000) {
    // Navigate first, then snapshot — never keep handles from an old /search page.
    if (!/^https:\/\/(www\.)?perplexity\.ai\/?$/.test(page.url().split("?")[0])) {
      await page.goto("https://www.perplexity.ai/", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    }
    try {
      await send(page, text);
      return await pollForResponse(page, null, timeoutMs, {
        label: "perplexity",
        stableChecks: 4,
        idleAfterBusyChecks: 4,
        prevText: "",
        hasNew: () =>
          page.evaluate(() => {
            const answers = [
              ...document.querySelectorAll(
                'div[class*="prose"], [class*="answer"], [data-testid*="answer"]',
              ),
            ].filter((el) => {
              if (el.closest('[contenteditable="true"], form, [role="textbox"]')) return false;
              return (el.textContent || "").trim().length > 0;
            });
            return answers.length > 0 || /\/search\//.test(location.pathname);
          }),
        lastText: () =>
          page.evaluate(() => {
            const answers = [
              ...document.querySelectorAll(
                'div[class*="prose"], [class*="answer"], [data-testid*="answer"]',
              ),
            ].filter((el) => {
              if (el.closest('[contenteditable="true"], form, [role="textbox"]')) return false;
              return (el.textContent || "").trim().length > 0;
            });
            const last = answers[answers.length - 1];
            if (!last) return null;
            return (last.textContent || "").replace(/\s+/g, " ").trim() || null;
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
            return false;
          }),
      });
    } finally {
      /* no prev handle */
    }
  },
};
