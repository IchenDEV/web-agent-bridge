import type { ElementHandle, Page } from "playwright";

/** One turn against a web agent page. */
export interface AdapterSendRequest {
  text: string;
  /** Timeout in ms; adapters fall back to their own default when unset. */
  timeoutMs?: number;
  /**
   * Progress callback: invoked with the *full snapshot* of the assistant
   * text each time it grows while polling. Backends turn this into deltas.
   */
  onText?: (snapshot: string) => void;
  /** Aborts the polling loop at the next tick (used by task cancellation). */
  signal?: AbortSignal;
}

export interface BrowserAdapter {
  readonly name: string;
  readonly url: string;
  readonly urlPattern: RegExp;
  sendAndWaitForResponse(page: Page, req: AdapterSendRequest): Promise<string>;
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

/** Transient page-eval errors (navigation, context destroyed) that are safe to retry. */
function isTransientEvalError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Cannot find context|Execution context was destroyed|Target closed|page has been closed/i.test(
    msg,
  );
}

/** Thrown when polling is aborted through `signal` (task cancelled). */
export class TurnCancelledError extends Error {
  constructor() {
    super("Response polling cancelled");
    this.name = "TurnCancelledError";
  }
}

/**
 * Poll until a new assistant node appears and the turn is truly idle.
 *
 * Important: `isStreaming` MUST stay true while the page is still working even
 * if assistant text is temporarily unchanged (tool calls, Feishu lookups, etc.).
 * Otherwise we return early and the next `send` interrupts an in-flight turn.
 *
 * `onText` receives complete snapshots of the assistant text as it grows —
 * this is the streaming hook used by the backend to publish deltas.
 *
 * `prevText` is the assistant text captured before send: if the DOM reuses
 * the same node (in-place update) or navigates mid-flight, a changed
 * `lastText` still counts as a new response.
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
    /** Assistant text captured before send (in-place-update fallback). */
    prevText?: string | null;
    /** Full-snapshot progress callback (streaming). */
    onText?: (snapshot: string) => void;
    /** Abort signal — checked every poll tick. */
    signal?: AbortSignal;
  },
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const interval = opts.intervalMs ?? 500;
  const needed = opts.stableChecks ?? 3;
  const idleAfterBusy = opts.idleAfterBusyChecks ?? needed;
  const baseline = opts.prevText ?? null;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new TurnCancelledError();
    try {
      if (await opts.hasNew(prev)) break;
      if (baseline !== null) {
        const now = (await opts.lastText()) ?? "";
        if (now.length > 0 && now !== baseline) break;
      }
    } catch (err) {
      if (!isTransientEvalError(err)) throw err;
    }
    await sleep(interval);
  }

  let appeared = false;
  try {
    appeared = await opts.hasNew(prev);
    if (!appeared && baseline !== null) {
      const now = (await opts.lastText()) ?? "";
      appeared = now.length > 0 && now !== baseline;
    }
  } catch (err) {
    if (!isTransientEvalError(err)) throw err;
  }
  if (opts.signal?.aborted) throw new TurnCancelledError();
  if (!appeared) {
    throw new Error(
      `Timeout: no new assistant message after ${Math.round(timeoutMs / 1000)}s (${opts.label})`,
    );
  }

  let last = "";
  let stable = 0;
  let idleSinceBusy = 0;
  let sawBusy = false;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new TurnCancelledError();
    let current = "";
    let streaming = false;
    try {
      current = (await opts.lastText()) ?? "";
      streaming = await opts.isStreaming();
    } catch (err) {
      if (!isTransientEvalError(err)) throw err;
      await sleep(interval);
      continue;
    }
    const changed = current.length > 0 && current !== last;

    if (changed) {
      last = current;
      opts.onText?.(current);
    }

    if (streaming) {
      sawBusy = true;
      stable = 0;
      idleSinceBusy = 0;
      await sleep(interval);
      continue;
    }

    if (changed) {
      // Text still growing while the page reports idle — not stable yet.
      stable = 0;
      idleSinceBusy = 0;
      await sleep(interval);
      continue;
    }

    if (current.length > 0) {
      stable += 1;
      if (sawBusy) idleSinceBusy += 1;
      const ready =
        stable >= needed && (!sawBusy || idleSinceBusy >= idleAfterBusy);
      if (ready) break;
    } else {
      stable = 0;
      idleSinceBusy = 0;
    }
    await sleep(interval);
  }

  // Final guard: never return while the page still reports busy.
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new TurnCancelledError();
    try {
      if (!(await opts.isStreaming())) break;
    } catch (err) {
      if (!isTransientEvalError(err)) throw err;
    }
    await sleep(interval);
  }
  if (opts.signal?.aborted) throw new TurnCancelledError();
  try {
    if (await opts.isStreaming()) {
      throw new Error(
        `Timeout: page still busy after ${Math.round(timeoutMs / 1000)}s (${opts.label})`,
      );
    }
  } catch (err) {
    if (!isTransientEvalError(err)) throw err;
  }

  await sleep(400);
  let text: string | null = null;
  try {
    text = await opts.lastText();
  } catch (err) {
    if (!isTransientEvalError(err)) throw err;
  }
  if (!text) throw new Error(`Could not extract assistant response (${opts.label})`);
  return text;
}