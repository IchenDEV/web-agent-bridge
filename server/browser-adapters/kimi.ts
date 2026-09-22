import type { ElementHandle, Page } from "playwright";
import { asElement, pollForResponse, type BrowserAdapter } from "./base.js";

const INPUT = [
  '[data-testid="msh-chatinput-editor"]',
  '[role="textbox"][contenteditable="true"]',
  '[data-testid="chat-input"][contenteditable="true"]',
  'div[contenteditable="true"]',
  'textarea[name="message"]',
  "textarea",
].join(", ");

async function snapshot(page: Page): Promise<ElementHandle | null> {
  return asElement(page, () => {
    const nodes = [...document.querySelectorAll(".chat-content-item-assistant, .segment-assistant")];
    return nodes.length ? nodes[nodes.length - 1] : null;
  });
}

async function send(page: Page, text: string): Promise<void> {
  await page.waitForSelector(INPUT, { timeout: 20_000 });
  await page.evaluate(async (message) => {
    const input = document.querySelector(
      '[data-testid="msh-chatinput-editor"], [role="textbox"][contenteditable="true"], [data-testid="chat-input"][contenteditable="true"], div[contenteditable="true"], textarea[name="message"], textarea',
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
              ...document.querySelectorAll(".chat-content-item-assistant, .segment-assistant"),
            ];
            if (nodes.length === 0) return false;
            if (!prevNode) return true;
            const last = nodes[nodes.length - 1];
            if (last === prevNode) {
              // Same node may update in place — treat non-empty new text as progress later.
              return false;
            }
            if (!(prevNode as Node).isConnected) return true;
            return !!((prevNode as Node).compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING);
          }, prevEl),
        lastText: () =>
          page.evaluate(() => {
            const nodes = [
              ...document.querySelectorAll(".chat-content-item-assistant, .segment-assistant"),
            ];
            const last = nodes[nodes.length - 1];
            if (!last) return null;
            const mds = [...last.querySelectorAll(".markdown")].filter(
              (m) => !m.closest(".toolcall-content"),
            );
            const pick = mds.length ? mds[mds.length - 1] : last.querySelector(".markdown") || last;
            let value = (pick.textContent || "").replace(/\s+/g, " ").trim();
            for (const noise of ["编辑", "复制", "分享"]) {
              value = value.replace(new RegExp(noise, "g"), "").trim();
            }
            return value || null;
          }),
        isStreaming: () =>
          page.evaluate(() => {
            for (const btn of document.querySelectorAll("button")) {
              const label = `${btn.getAttribute("aria-label") || ""} ${(btn.textContent || "").trim()}`;
              if (/^(停止|停止生成|Stop|Stop generating|收起工具调用)$/i.test(label.trim())) {
                // "收起工具调用" stays after done — only treat Stop* as busy
              }
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
