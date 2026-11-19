/** Private host-to-automation port. Never exposed as a model tool or public URL. */
export interface CdpEvent {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
  readonly targetId?: string;
}

export interface CdpCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Trusted host guard, rechecked after waits and immediately before dispatch. */
  readonly validate?: () => void;
}

export interface CdpTransport {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    sessionId?: string,
    options?: CdpCallOptions,
  ): Promise<T>;
  subscribe(listener: (event: CdpEvent) => void): () => void;
}

/** A failure after dispatch may have native effects; it is never replay advice. */
export interface CdpFailure extends Error {
  readonly code: string;
  readonly outcome: "not-dispatched" | "unknown";
  readonly retryable: false;
}
