/**
 * Shared retry timing for the chat reconnect path. Owners keep deciding
 * *whether* to retry; this module only answers *when*, so the physical socket,
 * the connection lifecycle and history recovery cannot drift apart.
 */
export const RECONNECT_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

/** A connection that stayed usable this long was lost, not refused: the next
 * attempt starts from the first delay instead of escalating the schedule. */
export const ESTABLISHED_CONNECTION_MS = 10_000;

export interface RetryDelayOptions {
  /** Explicit schedules (tests, operator overrides) are exact and never jittered. */
  readonly schedule?: readonly number[];
  readonly jitter?: boolean;
  readonly random?: () => number;
}

/** Delay before retry number `attempt` (0-based). Default schedule uses ±20% jitter. */
export function retryDelayMs(attempt: number, options: RetryDelayOptions = {}): number {
  const values = options.schedule ?? RECONNECT_DELAYS_MS;
  const index = Math.max(0, Math.min(Math.floor(attempt), values.length - 1));
  const base = values[index] ?? values[values.length - 1] ?? 60_000;
  if (options.schedule !== undefined || options.jitter === false) return Math.max(0, base);
  const random = Math.min(1, Math.max(0, options.random?.() ?? Math.random()));
  return Math.max(1, Math.round(base * (0.8 + random * 0.4)));
}

/** True when a lost connection had been usable long enough to reset escalation. */
export function wasEstablished(usableSince: number | null | undefined, now: number): boolean {
  return usableSince != null && now - usableSince >= ESTABLISHED_CONNECTION_MS;
}

export interface ExponentialBackoffOptions {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly factor?: number;
}

/** min(maxMs, initialMs * factor^attempt) for attempt >= 0; never Infinity/NaN.
 * Deterministic: callers that need jitter use retryDelayMs. */
export function exponentialBackoffMs(attempt: number, options: ExponentialBackoffOptions): number {
  const exponent = Math.max(0, Math.min(52, Number.isFinite(attempt) ? Math.floor(attempt) : 52));
  const value = options.initialMs * (options.factor ?? 2) ** exponent;
  return Math.max(0, Math.min(options.maxMs, Number.isFinite(value) ? value : options.maxMs));
}
