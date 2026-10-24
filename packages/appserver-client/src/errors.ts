import type { JsonRpcErrorObject } from "@opencraft/appserver-protocol";

export type AppServerClientErrorCode =
  | "ABORTED"
  | "CLOSED"
  | "HOST_EXISTS"
  | "HOST_NOT_FOUND"
  | "NOT_CONNECTED"
  | "PROTOCOL_ERROR"
  | "QUEUE_FULL"
  | "TIMEOUT"
  | "TRANSPORT_ERROR";

export class AppServerClientError extends Error {
  constructor(
    readonly code: AppServerClientErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AppServerClientError";
  }
}

export class AppServerRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: JsonRpcErrorObject) {
    super(error.message);
    this.name = "AppServerRpcError";
    this.code = error.code;
    if ("data" in error) this.data = error.data;
  }
}

export type ThreadUnavailableReason = "archived" | "not-found";

const ASCII_WORD_CHAR = /[A-Za-z0-9_]/;
const WHITESPACE_CHAR = /\s/u;

function hasAsciiWordBoundary(text: string, index: number): boolean {
  return ASCII_WORD_CHAR.test(text[index - 1] ?? "") !== ASCII_WORD_CHAR.test(text[index] ?? "");
}

function hasInsensitiveAsciiPhraseAt(text: string, index: number, phrase: string): boolean {
  const end = index + phrase.length;
  return end <= text.length
    && text.slice(index, end).toLowerCase() === phrase
    && hasAsciiWordBoundary(text, end);
}

function isThreadMissingPhraseAt(text: string, index: number): boolean {
  return hasInsensitiveAsciiPhraseAt(text, index, "not found")
    || hasInsensitiveAsciiPhraseAt(text, index, "no longer exists");
}

/** Linear NFA for `\bthread(?:\s+[^\n:]+)?(?:\s+|: )(?:not found|no longer exists)\b`. */
function hasThreadMissingAfter(text: string, start: number): boolean {
  const START = 1;
  const AFTER_WHITESPACE = 2;
  const IN_LABEL = 4;
  const AFTER_LABEL_WHITESPACE = 8;
  const AFTER_COLON = 16;
  const AFTER_COLON_SPACE = 32;
  const ACCEPT = AFTER_WHITESPACE | AFTER_LABEL_WHITESPACE | AFTER_COLON_SPACE;
  let states = START;
  for (let index = start; ; index++) {
    if ((states & ACCEPT) !== 0 && isThreadMissingPhraseAt(text, index)) return true;
    if (index >= text.length) return false;
    const char = text[index]!;
    const isWhitespace = WHITESPACE_CHAR.test(char);
    const isLabelChar = char !== "\n" && char !== ":";
    let next = 0;
    if ((states & START) !== 0) {
      if (isWhitespace) next |= AFTER_WHITESPACE;
      if (char === ":") next |= AFTER_COLON;
    }
    if ((states & AFTER_WHITESPACE) !== 0) {
      if (isWhitespace) next |= AFTER_WHITESPACE;
      if (isLabelChar) next |= IN_LABEL;
    }
    if ((states & IN_LABEL) !== 0) {
      if (isLabelChar) next |= IN_LABEL;
      if (isWhitespace) next |= AFTER_LABEL_WHITESPACE;
      if (char === ":") next |= AFTER_COLON;
    }
    if ((states & AFTER_LABEL_WHITESPACE) !== 0 && isWhitespace) next |= AFTER_LABEL_WHITESPACE;
    if ((states & AFTER_COLON) !== 0 && char === " ") next |= AFTER_COLON_SPACE;
    if (next === 0) return false;
    states = next;
  }
}

function isThreadNotFoundMessage(message: string): boolean {
  if (/\bno rollout found for thread id\b/iu.test(message)) return true;
  for (const match of message.matchAll(/thread/giu)) {
    if (ASCII_WORD_CHAR.test(message[match.index - 1] ?? "")) continue;
    if (hasThreadMissingAfter(message, match.index + match[0].length)) return true;
  }
  return false;
}

/** Only a Thread RPC rejection can retire a selection; transport errors cannot. */
export function threadUnavailableReason(error: unknown): ThreadUnavailableReason | null {
  if (!(error instanceof AppServerRpcError)) return null;
  const data = typeof error.data === "object" && error.data !== null
    ? error.data as { code?: unknown } : null;
  if (error.code === -32071 || data?.code === "THREAD_ARCHIVED"
    || /\b(?:thread|conversation)\b[^\n]*\b(?:is|was|has been) archived\b|\bcannot resume (?:an? )?archived (?:thread|conversation)\b/iu.test(error.message)) return "archived";
  if (data?.code === "THREAD_NOT_FOUND" || isThreadNotFoundMessage(error.message)) return "not-found";
  return null;
}

export function isRetryableAppServerRpcError(error: unknown): boolean {
  return error instanceof AppServerRpcError && threadUnavailableReason(error) === null
    && ![-32700, -32600, -32601, -32602].includes(error.code)
    && typeof error.data === "object" && error.data !== null
    && "retryable" in error.data && error.data.retryable === true;
}

/** A smaller history read may fit even though retrying the same response cannot.
 * Keep native transport compatibility; do not generalize to arbitrary RPC errors. */
export function isHistoryResponseTooLargeError(error: unknown): boolean {
  return error instanceof AppServerRpcError && (error.code === -32072
    || typeof error.data === "object" && error.data !== null
      && "code" in error.data && error.data.code === "HISTORY_RESPONSE_TOO_LARGE")
    || error instanceof Error && error.message.includes("decoded message length too large");
}
