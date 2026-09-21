import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { MessageBackend, StreamChunk } from "./message-backend.js";
import { ADAPTERS, adapterNames, getAdapter, type BrowserAdapter } from "./browser-adapters/index.js";
import { resolveCdpEndpoint } from "./cdp-discover.js";

export function userDataDir(): string {
  return process.env.WAB_USER_DATA_DIR || join(homedir(), ".web-agent-bridge", "chrome-profile");
}

/** Cookie/localStorage snapshot produced by `wab login`. */
export function storageStatePath(): string {
  return process.env.WAB_STORAGE_STATE || join(userDataDir(), "storage-state.json");
}

/**
 * Playwright backend.
 *
 * Connection order when `cdpUrl` is "auto" / omitted with preferCdp:
 *   1. Attach to an already-running Chromium (Dia / Chrome) over CDP
 *   2. Otherwise launch Chromium and load storage-state.json from `wab login`
 *
 * Prefer CDP so Doubao stays in the user's real logged-in browser.
 */
export class BrowserBackend implements MessageBackend {
  readonly name = "browser";
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private ready = false;
  private attached = false;
  private pages = new Map<string, Page>();
  private queue: Promise<unknown> = Promise.resolve();

  get connected(): boolean {
    if (!this.ready) return false;
    if (this.browser) return this.browser.isConnected();
    return this.context !== null;
  }

  statusDetails(): Record<string, unknown> {
    return {
      pages: this.openAgents(),
      mode: this.attached ? "cdp" : "launch",
    };
  }

  openAgents(): string[] {
    if (!this.context) return [];
    const open = new Set<string>();
    for (const page of this.context.pages()) {
      if (page.isClosed()) continue;
      const match = ADAPTERS.find((adapter) => adapter.urlPattern.test(page.url()));
      if (match) open.add(match.name);
    }
    return [...open];
  }

  /**
   * @param cdpUrl  Explicit CDP URL, `"auto"` to discover+attach (fall back to
   *                launch), `"launch"` to force a private Chromium, or omit
   *                (same as auto-prefer when WAB_PREFER_CDP is not `0`).
   */
  async connect(cdpUrl?: string): Promise<void> {
    const { chromium } = await import("playwright");
    const requested = (process.env.CDP_URL || cdpUrl || "").trim();
    const forceLaunch = requested === "launch";
    const preferAttach =
      !forceLaunch &&
      (requested === "auto" ||
        requested.startsWith("http") ||
        requested.startsWith("ws") ||
        (requested === "" && process.env.WAB_PREFER_CDP !== "0"));

    if (preferAttach) {
      const resolved =
        requested && requested !== "auto"
          ? { endpoint: requested, source: "explicit" as const }
          : await resolveCdpEndpoint("auto");

      if (resolved) {
        try {
          this.browser = await chromium.connectOverCDP(resolved.endpoint, { timeout: 20_000 });
          this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
          this.attached = true;
          const agents = this.openAgents();
          console.error(
            `[BrowserBackend] Attached over CDP ${resolved.endpoint} (${resolved.source})` +
              (agents.length ? ` — open: ${agents.join(", ")}` : " — no agent tabs yet"),
          );
          this.ready = true;
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (requested && requested !== "auto") {
            throw new Error(`CDP attach failed (${resolved.endpoint}): ${message}`);
          }
          console.error(
            `[BrowserBackend] CDP attach failed (${resolved.endpoint}): ${message}; launching instead`,
          );
        }
      } else if (requested === "auto") {
        throw new Error(
          "No CDP endpoint found. For Dia (your current browser), run:\n" +
            "  wab cdp\n" +
            "Then: wab server --browser --cdp auto --acp",
        );
      }
    }

    const headless = process.env.WAB_HEADLESS !== "0";
    const statePath = storageStatePath();
    this.browser = await chromium.launch({
      headless,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    this.context = await this.browser.newContext({
      storageState: existsSync(statePath) ? statePath : undefined,
    });
    this.attached = false;
    console.error(
      `[BrowserBackend] Launched Chromium (${headless ? "headless" : "headed"})` +
        (existsSync(statePath) ? ` with ${statePath}` : " (no storage state — prefer: wab cdp)"),
    );
    this.ready = true;
  }

  async *sendAndStream(
    taskId: string,
    text: string,
    timeoutMs = 180_000,
    target?: string,
  ): AsyncGenerator<StreamChunk> {
    const reply = await this.sendAndWait(taskId, text, timeoutMs, target);
    yield { text: reply, done: true };
  }

  async sendAndWait(
    taskId: string,
    text: string,
    timeoutMs = 180_000,
    target?: string,
  ): Promise<string> {
    return this.enqueue(async () => {
      if (!this.connected || !this.context) {
        throw new Error("Browser backend is not connected");
      }
      const adapter = this.resolveAdapter(target);
      const page = await this.ensurePage(adapter);
      console.error(`[BrowserBackend] ${adapter.name} task ${taskId}: "${text.slice(0, 60)}"`);
      return adapter.sendAndWaitForResponse(page, text, timeoutMs);
    });
  }

  close(): void {
    this.ready = false;
    this.pages.clear();
    if (this.attached) {
      // Detach only — do not close the user's Dia/Chrome window.
      void this.browser?.close().catch(() => undefined);
    } else {
      void this.context?.close().catch(() => undefined);
      void this.browser?.close().catch(() => undefined);
    }
    this.context = null;
    this.browser = null;
    this.attached = false;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private resolveAdapter(target?: string): BrowserAdapter {
    if (target) {
      const adapter = getAdapter(target);
      if (!adapter) {
        throw new Error(`Unknown target agent "${target}". Available: ${adapterNames()}`);
      }
      return adapter;
    }

    if (this.context) {
      for (const page of this.context.pages()) {
        if (page.isClosed()) continue;
        const match = ADAPTERS.find((adapter) => adapter.urlPattern.test(page.url()));
        if (match) return match;
      }
    }

    return doubaoOrFirst();
  }

  private async ensurePage(adapter: BrowserAdapter): Promise<Page> {
    const cached = this.pages.get(adapter.name);
    if (cached && !cached.isClosed()) {
      await bringToFront(cached);
      return cached;
    }

    const context = this.context;
    if (!context) throw new Error("Browser context is not available");

    // Prefer an already-open Doubao/ChatGPT/... tab in the user's browser.
    for (const page of context.pages()) {
      if (!page.isClosed() && adapter.urlPattern.test(page.url())) {
        this.pages.set(adapter.name, page);
        await bringToFront(page);
        return page;
      }
    }

    // Also search other CDP contexts (Dia sometimes isolates windows).
    if (this.browser) {
      for (const ctx of this.browser.contexts()) {
        for (const page of ctx.pages()) {
          if (!page.isClosed() && adapter.urlPattern.test(page.url())) {
            this.context = ctx;
            this.pages.set(adapter.name, page);
            await bringToFront(page);
            return page;
          }
        }
      }
    }

    const page = await context.newPage();
    await page.goto(adapter.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    this.pages.set(adapter.name, page);
    await bringToFront(page);
    return page;
  }
}

async function bringToFront(page: Page): Promise<void> {
  try {
    await page.bringToFront();
  } catch {
    /* Dia may ignore bringToFront — still usable */
  }
}

function doubaoOrFirst(): BrowserAdapter {
  return getAdapter("doubao") ?? ADAPTERS[0];
}

/** Ensure the directory for storage-state.json exists. */
export function ensureProfileDir(): string {
  const dir = userDataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}
