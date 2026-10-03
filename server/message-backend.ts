/**
 * Unified MessageBackend interface that both WsBridge (Chrome extension)
 * and BrowserBackend (Playwright) implement. The BackendRouter aggregates
 * multiple backends and routes requests to the appropriate one.
 */

import { DEFAULT_TIMEOUT_MS } from "./config.js";

/** A single send request, routed through any MessageBackend. */
export interface SendOptions {
  /** Correlation id for this turn. */
  taskId: string;
  /** User message text. */
  text: string;
  /** Per-request timeout in ms; defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Target web agent: `doubao` | `chatgpt` | `gemini` | `workbuddy` (auto if omitted). */
  target?: string;
  /**
   * Preferred backend name (`extension` | `browser`).
   * Only consumed by BackendRouter; plain backends ignore it, which lets
   * callers pass routing info without `instanceof` checks.
   */
  backend?: string;
}

/**
 * One unit of streamed output.
 *
 * `text` semantics:
 *   - `done: false` → incremental delta since the previous chunk
 *   - `done: true`  → final complete text (consumers should prefer it over
 *     the accumulated deltas when non-empty)
 */
export interface StreamChunk {
  text: string;
  done: boolean;
  parts?: Array<{ type: string; content: string; mediaType: string; filename?: string }>;
  error?: string;
}

export function resolveTimeout(timeoutMs: number | undefined): number {
  return timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}

export interface MessageBackend {
  readonly name: string;
  readonly connected: boolean;

  /** Extra fields merged into `/health` for this backend. */
  statusDetails?(): Record<string, unknown>;

  sendAndStream(req: SendOptions): AsyncGenerator<StreamChunk>;

  sendAndWait(req: SendOptions): Promise<string>;

  /**
   * Best-effort cancellation: stop waiting locally and, when possible,
   * tell the remote side (extension page / browser tab) to stop working.
   * Unknown task ids are ignored.
   */
  cancel(taskId: string): void;

  close(): void;
}

export interface BackendStatus {
  connected: boolean;
  [key: string]: unknown;
}

/**
 * Routes requests to one of several registered MessageBackend instances.
 *
 * Selection logic (in order):
 *   1. Explicit `backend` field on the request
 *   2. The default backend
 *   3. Fallback: any connected backend
 */
export class BackendRouter implements MessageBackend {
  readonly name = "router";
  private backends = new Map<string, MessageBackend>();
  private _default: string;

  constructor(defaultBackend: string) {
    this._default = defaultBackend;
  }

  register(backend: MessageBackend): void {
    this.backends.set(backend.name, backend);
  }

  get defaultBackend(): string {
    return this._default;
  }

  set defaultBackend(name: string) {
    this._default = name;
  }

  get connected(): boolean {
    for (const b of this.backends.values()) {
      if (b.connected) return true;
    }
    return false;
  }

  /** Get status of all registered backends. */
  status(): Record<string, BackendStatus> {
    const result: Record<string, BackendStatus> = {};
    for (const [name, b] of this.backends) {
      result[name] = { connected: b.connected, ...(b.statusDetails?.() ?? {}) };
    }
    return result;
  }

  /** Get a specific backend by name. */
  getBackend(name: string): MessageBackend | undefined {
    return this.backends.get(name);
  }

  /** Resolve which backend to use for a request. */
  private resolve(preferred?: string): MessageBackend {
    // 1. Explicit choice
    if (preferred) {
      const b = this.backends.get(preferred);
      if (b?.connected) return b;
      if (b) {
        console.warn(
          `[BackendRouter] Requested backend "${preferred}" is not connected, falling back`,
        );
      }
    }

    // 2. Default backend
    const def = this.backends.get(this._default);
    if (def?.connected) return def;

    // 3. Any connected backend
    for (const b of this.backends.values()) {
      if (b.connected) return b;
    }

    throw new Error(
      `No connected backend available (registered: ${[...this.backends.keys()].join(", ")})`,
    );
  }

  async *sendAndStream(req: SendOptions): AsyncGenerator<StreamChunk> {
    yield* this.resolve(req.backend).sendAndStream(req);
  }

  async sendAndWait(req: SendOptions): Promise<string> {
    return this.resolve(req.backend).sendAndWait(req);
  }

  /** Broadcast cancellation to every backend — each ignores unknown tasks. */
  cancel(taskId: string): void {
    for (const b of this.backends.values()) {
      try {
        b.cancel(taskId);
      } catch (err: any) {
        console.warn(`[BackendRouter] cancel failed on "${b.name}": ${err?.message ?? err}`);
      }
    }
  }

  close(): void {
    for (const b of this.backends.values()) {
      b.close();
    }
  }
}