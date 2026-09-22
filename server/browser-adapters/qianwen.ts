import type { ElementHandle, Page } from "playwright";
import { asElement, pollForResponse, type BrowserAdapter } from "./base.js";

const INPUT = [
  "#chat-input",
  "textarea.text-area-box-web",
  "textarea.message-input-textarea",
  '[role="textbox"][contenteditable="true"]',
  "textarea",
].join(", ");

async function snapshot(page: Page): Promise<ElementHandle | null> {
  return asElement(page, () => {
    const nodes = [
      ...document.querySelectorAll(
        '[data-msgid$="-answer"], [data-chat-answers-wrap], .qwen-chat-message-assistant, .response-message-content.phase-answer, #qk-markdown-react, [class*="response-message"]',
      ),
    ].filter((el) => (el.textContent || "").trim().length > 4);
    return nodes.length ? nodes[nodes.length - 1] : null;
  });
}

async function send(page: Page, text: string): Promise<void> {
  await page.waitForSelector(INPUT, { timeout: 20_000 });
  await page.evaluate(async (message) => {
    const input = document.querySelector(
      '#chat-input, textarea.text-area-box-web, textarea.message-input-textarea, [role="textbox"][contenteditable="true"], textarea',
    ) as HTMLElement | null;
    if (!input) throw new Error("Qianwen input not found");
    input.focus();
    await new Promise((r) => setTimeout(r, 150));
    if (input instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      setter?.call(input, message);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
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
      'button[aria-label="发送消息"], .message-input-right-button-send, .chat-prompt-send-button .send-button, button[aria-label*="发送"]',
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

export const qianwenAdapter: BrowserAdapter = {
  name: "qianwen",
  url: "https://www.qianwen.com/",
  urlPattern: /^https:\/\/(www\.)?(qianwen\.com|chat\.qwen\.ai|tongyi\.aliyun\.com)\//,
  async sendAndWaitForResponse(page, text, timeoutMs = 180_000) {
    const prev = await snapshot(page);
    try {
      await send(page, text);
      return await pollForResponse(page, prev, timeoutMs, {
        label: "qianwen",
        stableChecks: 5,
        idleAfterBusyChecks: 6,
        hasNew: (prevEl) =>
          page.evaluate((prevNode) => {
            const nodes = [
              ...document.querySelectorAll(
                '[data-msgid$="-answer"], [data-chat-answers-wrap], .qwen-chat-message-assistant, .response-message-content.phase-answer, #qk-markdown-react, [class*="response-message"]',
              ),
            ].filter((el) => (el.textContent || "").trim().length > 4);
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
                '[data-msgid$="-answer"], [data-chat-answers-wrap], .qwen-chat-message-assistant, .response-message-content.phase-answer, #qk-markdown-react, [class*="response-message"]',
              ),
            ].filter((el) => (el.textContent || "").trim().length > 4);
            const last = nodes[nodes.length - 1];
            if (!last) return null;
            const md =
              last.querySelector("#qk-markdown-react, [class*=\"markdown\"], .response-message-content") ||
              last;
            return ((md.textContent || "").replace(/\s+/g, " ").trim()) || null;
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
            if (document.querySelector(".chat-prompt-send-button .stop-button")) return true;
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
