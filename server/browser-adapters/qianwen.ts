import type { Page } from "playwright";
import { pollForResponse, type BrowserAdapter } from "./base.js";

/** Domestic qianwen.com uses Lexical contenteditable; chat.qwen.ai may still use textarea. */
const INPUT = [
  '[role="textbox"][contenteditable="true"]',
  "#chat-input",
  "textarea.text-area-box-web",
  "textarea.message-input-textarea",
  '[contenteditable="true"]',
  "textarea",
].join(", ");

async function send(page: Page, text: string): Promise<void> {
  await page.waitForSelector(INPUT, { timeout: 20_000 });
  // Qianwen's Lexical composer often ignores execCommand; type via CDP keyboard instead.
  const box = page.locator('[role="textbox"][contenteditable="true"]').first();
  await box.click({ timeout: 10_000 });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text, { delay: 15 });
  await page.waitForTimeout(500);

  const sendBtn = page.locator('button[aria-label="发送消息"]');
  try {
    await sendBtn.waitFor({ state: "visible", timeout: 5_000 });
    // Wait until armed
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const disabled = await sendBtn.isDisabled().catch(() => true);
      if (!disabled) {
        await sendBtn.click();
        return;
      }
      await page.waitForTimeout(150);
    }
  } catch {
    /* fall through to Enter */
  }
  await page.keyboard.press("Enter");
}

export const qianwenAdapter: BrowserAdapter = {
  name: "qianwen",
  url: "https://www.qianwen.com/",
  urlPattern: /^https:\/\/(www\.)?(qianwen\.com|chat\.qwen\.ai|tongyi\.aliyun\.com)\//,
  async sendAndWaitForResponse(page, text, timeoutMs = 180_000) {
    // Always start from home so snapshot/prev handles stay valid and answers are fresh.
    if (!/^https:\/\/(www\.)?qianwen\.com\/?$/.test(page.url().split("?")[0])) {
      await page.goto("https://www.qianwen.com/", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    }
    try {
      await send(page, text);
      return await pollForResponse(page, null, timeoutMs, {
        label: "qianwen",
        stableChecks: 4,
        idleAfterBusyChecks: 4,
        prevText: "",
        hasNew: () =>
          page.evaluate(() => {
            const nodes = [
              ...document.querySelectorAll(
                '.chat-answers-card-wrap, .answer-common-card, .qk-markdown-react, .markdown-pc-special-class, [class*="message-select-wrapper-answer"]',
              ),
            ].filter((el) => {
              if (el.closest('[contenteditable="true"], [role="textbox"]')) return false;
              return (el.textContent || "").trim().length > 0;
            });
            return nodes.length > 0;
          }),
        lastText: () =>
          page.evaluate(() => {
            const nodes = [
              ...document.querySelectorAll(
                '.chat-answers-card-wrap, .answer-common-card, .qk-markdown-react, .markdown-pc-special-class, [class*="message-select-wrapper-answer"]',
              ),
            ].filter((el) => {
              if (el.closest('[contenteditable="true"], [role="textbox"]')) return false;
              return (el.textContent || "").trim().length > 0;
            });
            const last = nodes[nodes.length - 1];
            if (!last) return null;
            const md =
              last.querySelector('.qk-markdown-react, .markdown-pc-special-class, [class*="markdown"]') ||
              last;
            return ((md.textContent || "").replace(/\s+/g, " ").trim()) || null;
          }),
        isStreaming: () =>
          page.evaluate(() => {
            for (const btn of document.querySelectorAll("button")) {
              const label = `${btn.getAttribute("aria-label") || ""} ${(btn.textContent || "").trim()}`;
              // Only real stop controls — ignore disabled send button.
              if (/^(停止|停止生成|Stop|Stop generating)$/i.test(label.trim())) {
                const r = btn.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return true;
              }
            }
            if (document.querySelector(".chat-prompt-send-button .stop-button")) return true;
            // Do NOT match global animate-spin — qianwen keeps decorative spinners in the shell.
            const answer = document.querySelector(
              '.chat-answers-card-wrap, [class*="message-select-wrapper-answer"]',
            );
            if (
              answer?.querySelector(
                '[class*="animate-spin"], [class*="loading"], [class*="spinner"], [aria-busy="true"]',
              )
            ) {
              return true;
            }
            return false;
          }),
      });
    } finally {
      /* no prev handle */
    }
  },
};
