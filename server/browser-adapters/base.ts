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
 * Poll until a new assistant node appears and the turn is truly idle.
 *
 * Important: `isStreaming` MUST stay true while the page is still working even
 * if assistant text is temporarily unchanged (tool calls, Feishu lookups, etc.).
 * Otherwise we return early and the next `send` interrupts an in-flight turn.
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
    /** Consecutive idle polls required after text stops changing. */
    stableChecks?: number;
    /** Extra idle polls required after the last time `isStreaming` was true. */
    idleAfterBusyChecks?: number;
  },
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const interval = opts.intervalMs ?? 500;
  const needed = opts.stableChecks ?? 3;
  const idleAfterBusy = opts.idleAfterBusyChecks ?? needed;

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
  let idleSinceBusy = 0;
  let sawBusy = false;

  while (Date.now() < deadline) {
    const current = (await opts.lastText()) ?? "";
    const streaming = await opts.isStreaming();

    if (streaming) {
      sawBusy = true;
      stable = 0;
      idleSinceBusy = 0;
      last = current;
      await sleep(interval);
      continue;
    }

    if (current.length > 0 && current === last) {
      stable += 1;
      if (sawBusy) idleSinceBusy += 1;
      const ready =
        stable >= needed && (!sawBusy || idleSinceBusy >= idleAfterBusy);
      if (ready) break;
    } else {
      stable = 0;
      idleSinceBusy = 0;
      last = current;
    }
    await sleep(interval);
  }

  // Final guard: never return while the page still reports busy.
  while (Date.now() < deadline && (await opts.isStreaming())) {
    await sleep(interval);
  }
  if (await opts.isStreaming()) {
    throw new Error(
      `Timeout: page still busy after ${Math.round(timeoutMs / 1000)}s (${opts.label})`,
    );
  }

  await sleep(400);
  const text = await opts.lastText();
  if (!text) throw new Error(`Could not extract assistant response (${opts.label})`);
  return text;
}
