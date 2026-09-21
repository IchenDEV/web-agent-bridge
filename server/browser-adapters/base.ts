import type { ElementHandle, Page } from "playwright";

export interface BrowserAdapter {
  readonly name: string;
  readonly url: string;
  readonly urlPattern: RegExp;
  sendAndWaitForResponse(page: Page, text: string, timeoutMs?: number): Promise<string>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve an ElementHandle from the page.
 * Keep the callback free of named inner functions — tsx injects `__name(...)`
 * which breaks Playwright's function serialization into the browser.
 */
export async function asElement(
  page: Page,
  fn: () => Element | null,
): Promise<ElementHandle | null> {
  const handle = await page.evaluateHandle(fn);
  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    return null;
  }
  return element;
}

/**
 * Poll until a new assistant node appears and its text stops changing.
 * `prev` is the assistant node that existed before this turn (or null).
 */
export async function pollForResponse(
  page: Page,
  prev: ElementHandle | null,
  timeoutMs: number,
  opts: {
    label: string;
    hasNew: (prev: ElementHandle | null) => Promise<boolean>;
    lastText: () => Promise<string | null>;
    isStreaming: () => Promise<boolean>;
    intervalMs?: number;
    stableChecks?: number;
  },
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const interval = opts.intervalMs ?? 500;
  const needed = opts.stableChecks ?? 3;

  while (Date.now() < deadline) {
    if (await opts.hasNew(prev)) break;
    await sleep(interval);
  }
  if (!(await opts.hasNew(prev))) {
    throw new Error(
      `Timeout: no new assistant message after ${Math.round(timeoutMs / 1000)}s (${opts.label})`,
    );
  }

  let last = "";
  let stable = 0;
  while (Date.now() < deadline) {
    const current = (await opts.lastText()) ?? "";
    const streaming = await opts.isStreaming();
    if (current.length > 0 && current === last && !streaming) {
      stable += 1;
      if (stable >= needed) break;
    } else {
      stable = 0;
      last = current;
    }
    await sleep(interval);
  }

  await sleep(300);
  const text = await opts.lastText();
  if (!text) throw new Error(`Could not extract assistant response (${opts.label})`);
  return text;
}
