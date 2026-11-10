/**
 * Bounded JSONL transport contract between an Engine Host and a provider
 * bridge. This module is pure: it describes framing and discrimination rules,
 * it does not own a socket, a child process, or any IO.
 *
 * Discipline (mirrors the design's edge/core split): the envelope is lenient
 * about unknown fields so plugin/host version skew is tolerable, but a frame
 * that cannot be classified is answered with a typed error instead of being
 * dropped. An over-long frame is isolated to that one line so a single greedy
 * writer cannot wedge the stream.
 */

/** Default cap on a single JSONL line, in bytes (UTF-8). */
export const BRIDGE_MAX_FRAME_BYTES = 1_048_576;

export interface BridgeFrameLimits {
  readonly maxFrameBytes: number;
}

export const DEFAULT_BRIDGE_FRAME_LIMITS: BridgeFrameLimits = Object.freeze({
  maxFrameBytes: BRIDGE_MAX_FRAME_BYTES,
});

export type BridgeRequestId = string;

export interface BridgeRequest<TParams = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: BridgeRequestId;
  readonly method: string;
  readonly params?: TParams;
}

/** A Host -> bridge or bridge -> Host notification. Never carries an id. */
export interface BridgeNotification<TParams = unknown> {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: TParams;
}

export interface BridgeSuccess<TResult = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: BridgeRequestId;
  readonly result: TResult;
}

export type BridgeErrorKind =
  | "invalid"
  | "unsupported"
  | "stale-target"
  | "auth"
  | "quota"
  | "unknown-outcome"
  | "explicit-reject"
  | "frame-too-large"
  | "internal";

export interface BridgeErrorObject {
  readonly code: number;
  readonly message: string;
  readonly kind: BridgeErrorKind;
  readonly data?: unknown;
}

export interface BridgeFailure {
  readonly jsonrpc: "2.0";
  readonly id: BridgeRequestId | null;
  readonly error: BridgeErrorObject;
}

export type BridgeWireMessage =
  | BridgeRequest
  | BridgeNotification
  | BridgeSuccess
  | BridgeFailure;

export const BRIDGE_ERROR_CODES = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unsupportedCapability: -32001,
  staleTarget: -32002,
  auth: -32003,
  quota: -32004,
  unknownOutcome: -32005,
  explicitReject: -32006,
  frameTooLarge: -32007,
} as const);

export function makeBridgeError(
  kind: BridgeErrorKind,
  code: number,
  message: string,
  data?: unknown,
): BridgeErrorObject {
  return data === undefined
    ? { kind, code, message }
    : { kind, code, message, data };
}

/** A response that rejects a request whose method or capability is unavailable. */
export function bridgeFailure(id: BridgeRequestId | null, error: BridgeErrorObject): BridgeFailure {
  return { jsonrpc: "2.0", id, error };
}

export function isRequest(message: BridgeWireMessage): message is BridgeRequest {
  return "method" in message && "id" in message && (message as BridgeRequest).id !== undefined;
}

export function isNotification(message: BridgeWireMessage): message is BridgeNotification {
  return "method" in message && !("id" in message);
}

export function isSuccess(message: BridgeWireMessage): message is BridgeSuccess {
  return !("method" in message) && "result" in message;
}

export function isFailure(message: BridgeWireMessage): message is BridgeFailure {
  return !("method" in message) && "error" in message;
}

export type FrameOutcome =
  | { readonly kind: "message"; readonly message: BridgeWireMessage }
  | {
      readonly kind: "error";
      readonly error: BridgeErrorObject;
      /** True when the stream may keep reading after this line. */
      readonly recoverable: boolean;
    };

function byteLength(line: string): number {
  let bytes = 0;
  for (let index = 0; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < line.length) {
      const next = line.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): FrameOutcome {
  return {
    kind: "error",
    error: makeBridgeError("invalid", BRIDGE_ERROR_CODES.invalidParams, message),
    recoverable: true,
  };
}

/**
 * Decode one bounded JSONL line into a discriminated wire message.
 * Requests are discriminated by the presence of `method` (never by result
 * shape); the two directions keep independent request-id spaces by convention,
 * not by anything this function assumes.
 */
export function decodeFrame(
  raw: string,
  limits: BridgeFrameLimits = DEFAULT_BRIDGE_FRAME_LIMITS,
): FrameOutcome {
  if (byteLength(raw) > limits.maxFrameBytes) {
    return {
      kind: "error",
      error: makeBridgeError(
        "frame-too-large",
        BRIDGE_ERROR_CODES.frameTooLarge,
        `bridge frame exceeds ${limits.maxFrameBytes} bytes`,
      ),
      recoverable: true,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    return {
      kind: "error",
      error: makeBridgeError("invalid", BRIDGE_ERROR_CODES.parse, "undecodable JSONL frame", String(cause)),
      recoverable: true,
    };
  }

  if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
    return invalid("frame is not a JSON-RPC 2.0 object");
  }

  const hasMethod = typeof parsed.method === "string";
  const hasId = typeof parsed.id === "string" || typeof parsed.id === "number";

  if (hasMethod) {
    if (hasId) {
      return {
        kind: "message",
        message: {
          jsonrpc: "2.0",
          id: String(parsed.id),
          method: parsed.method as string,
          ...(parsed.params !== undefined ? { params: parsed.params } : {}),
        },
      };
    }
    return {
      kind: "message",
      message: {
        jsonrpc: "2.0",
        method: parsed.method as string,
        ...(parsed.params !== undefined ? { params: parsed.params } : {}),
      },
    };
  }

  if (hasId) {
    if ("result" in parsed) {
      return {
        kind: "message",
        message: { jsonrpc: "2.0", id: String(parsed.id), result: parsed.result },
      };
    }
    if (isRecord(parsed.error) && typeof parsed.error.code === "number" && typeof parsed.error.message === "string") {
      const kind = typeof parsed.error.kind === "string" ? (parsed.error.kind as BridgeErrorKind) : "internal";
      return {
        kind: "message",
        message: {
          jsonrpc: "2.0",
          id: String(parsed.id),
          error: {
            kind,
            code: parsed.error.code,
            message: parsed.error.message,
            ...(parsed.error.data !== undefined ? { data: parsed.error.data } : {}),
          },
        },
      };
    }
    return invalid("response without method needs a result or a typed error");
  }

  return invalid("frame cannot be classified as a request, notification, or response");
}

export function encodeFrame(message: BridgeWireMessage): string {
  return JSON.stringify(message);
}

/**
 * A bounded line splitter over an already-buffered chunk. It keeps an
 * incomplete trailing line for the next chunk and isolates over-long lines the
 * same way `decodeFrame` does; it performs no IO.
 */
export function splitLines(chunk: string, carry = ""): { lines: string[]; carry: string } {
  const text = carry + chunk;
  const parts = text.split("\n");
  const carryOut = parts.pop() ?? "";
  return { lines: parts, carry: carryOut };
}
