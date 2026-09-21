/**
 * Unified MessageBackend interface that both WsBridge (Chrome extension)
 * and BrowserBackend (Playwright) implement. The BackendRouter aggregates
 * multiple backends and routes requests to the appropriate one.
 */

export interface StreamChunk {
  text: string;
  done: boolean;
  parts?: Array<{ type: string; content: string; mediaType: string; filename?: string }>;
  error?: string;
}

export interface MessageBackend {
  readonly name: string;
  readonly connected: boolean;

  /** Extra fields merged into `/health` for this backend. */
  statusDetails?(): Record<string, unknown>;

  sendAndStream(
    taskId: string,
    text: string,
    timeoutMs?: number,
    target?: string,
  ): AsyncGenerator<StreamChunk>;

  sendAndWait(
    taskId: string,
    text: string,
    timeoutMs?: number,
    target?: string,
  ): Promise<string>;

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
 *   1. Explicit `backend` parameter passed by the caller
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

  async *sendAndStream(
    taskId: string,
    text: string,
    timeoutMs = 180_000,
    target?: string,
  ): AsyncGenerator<StreamChunk> {
    yield* this.resolve().sendAndStream(taskId, text, timeoutMs, target);
  }

  async sendAndWait(
    taskId: string,
    text: string,
    timeoutMs = 180_000,
    target?: string,
  ): Promise<string> {
    return this.resolve().sendAndWait(taskId, text, timeoutMs, target);
  }

  /**
   * Extended send that accepts explicit backend selection separate from target agent.
   */
  async *sendAndStreamVia(
    backendName: string | undefined,
    taskId: string,
    text: string,
    timeoutMs = 180_000,
    target?: string,
  ): AsyncGenerator<StreamChunk> {
    const backend = this.resolve(backendName);
    yield* backend.sendAndStream(taskId, text, timeoutMs, target);
  }

  async sendAndWaitVia(
    backendName: string | undefined,
    taskId: string,
    text: string,
    timeoutMs = 180_000,
    target?: string,
  ): Promise<string> {
    const backend = this.resolve(backendName);
    return backend.sendAndWait(taskId, text, timeoutMs, target);
  }

  close(): void {
    for (const b of this.backends.values()) {
      b.close();
    }
  }
}
