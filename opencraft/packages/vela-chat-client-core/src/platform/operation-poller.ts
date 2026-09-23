import type {Operation} from "./api.js";
import {PlatformError} from "./errors.js";

const DEFAULT_WINDOW_MS = 30_000;
const LONG_RETRY_AFTER_SECONDS = 30;

export type OperationPollResult =
  | {kind: "aborted"; operation: Operation}
  | {kind: "query_error"; error: PlatformError; operation: Operation}
  | {
      kind: "rate_limited";
      operation: Operation;
      retryAfterSeconds: number;
    }
  | {kind: "terminal"; operation: Operation}
  | {kind: "timed_out"; operation: Operation};

export interface PollOperationOptions {
  initial: Operation;
  load(signal?: AbortSignal): Promise<Operation>;
  maxWindowMs?: number;
  now?: () => number;
  onUpdate?: (operation: Operation) => void;
  signal?: AbortSignal;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export function isOperationTerminal(operation: Operation): boolean {
  return ["succeeded", "failed", "uncertain", "superseded"].includes(
    operation.state,
  );
}

export async function pollOperation(
  options: PollOperationOptions,
): Promise<OperationPollResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const maxWindowMs = options.maxWindowMs ?? DEFAULT_WINDOW_MS;
  const startedAt = now();
  let current = options.initial;
  let nextDelayMs = 1_000;

  if (options.signal?.aborted) {
    return {kind: "aborted", operation: current};
  }
  options.onUpdate?.(current);

  while (!isOperationTerminal(current)) {
    const elapsed = Math.max(0, now() - startedAt);
    const remaining = maxWindowMs - elapsed;
    if (remaining <= 0) {
      return {kind: "timed_out", operation: current};
    }

    try {
      await sleep(Math.min(nextDelayMs, remaining), options.signal);
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) {
        return {kind: "aborted", operation: current};
      }
      throw error;
    }
    if (options.signal?.aborted) {
      return {kind: "aborted", operation: current};
    }
    if (now() - startedAt >= maxWindowMs) {
      return {kind: "timed_out", operation: current};
    }

    try {
      current = await options.load(options.signal);
      if (options.signal?.aborted) {
        return {kind: "aborted", operation: current};
      }
      options.onUpdate?.(current);
      const pollElapsed = Math.max(0, now() - startedAt);
      nextDelayMs = pollElapsed < 10_000 ? 1_000 : 2_000;
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) {
        return {kind: "aborted", operation: current};
      }
      if (!(error instanceof PlatformError)) {
        nextDelayMs = transientBackoff(nextDelayMs);
        continue;
      }
      if (error.code === "AUTH_REQUIRED") throw error;
      if (
        error.code === "AUTH_FORBIDDEN" ||
        error.code === "RESOURCE_NOT_FOUND"
      ) {
        return {error, kind: "query_error", operation: current};
      }
      if (error.code === "RATE_LIMITED") {
        const retryAfterSeconds = error.retryAfterSeconds ?? 1;
        if (retryAfterSeconds > LONG_RETRY_AFTER_SECONDS) {
          return {
            kind: "rate_limited",
            operation: current,
            retryAfterSeconds,
          };
        }
        nextDelayMs = Math.max(1_000, retryAfterSeconds * 1_000);
        continue;
      }
      nextDelayMs = transientBackoff(nextDelayMs);
    }
  }

  return {kind: "terminal", operation: current};
}

function transientBackoff(current: number): number {
  return Math.min(Math.max(2_000, current * 2), 8_000);
}

function abortableSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, {once: true});
  });
}

function abortError(): Error {
  const error = new Error("Operation polling aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
