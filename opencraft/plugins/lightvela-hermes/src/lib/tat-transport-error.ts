export type TatTransportFailureKind =
  | "connection_lost"
  | "lease_expired"
  | "proxy_unavailable"
  | "request_timeout"
  | "fatal";

export type TatTransportPhase =
  | "connect"
  | "pty_start"
  | "open_proxy"
  | "request"
  | "response_body"
  | "response_head"
  | "websocket";

export class TatTransportError extends Error {
  readonly kind: TatTransportFailureKind;
  readonly phase: TatTransportPhase;
  readonly retryable: boolean;

  constructor(
    kind: TatTransportFailureKind,
    message: string,
    input: {
      cause?: unknown;
      phase: TatTransportPhase;
      retryable?: boolean;
    },
  ) {
    super(message);
    this.name = "TatTransportError";
    this.cause = input.cause;
    this.kind = kind;
    this.phase = input.phase;
    this.retryable = input.retryable ?? kind !== "fatal";
  }
}

export function isTatTransportError(error: unknown): error is TatTransportError {
  return error instanceof TatTransportError;
}

export function normalizeTatTransportError(
  error: unknown,
  phase: TatTransportPhase,
): TatTransportError {
  if (error instanceof TatTransportError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes("session not valid")) {
    return new TatTransportError("lease_expired", message, { cause: error, phase });
  }
  if (
    lowerMessage.includes("timed out") ||
    lowerMessage.includes("timeout")
  ) {
    return new TatTransportError("request_timeout", message, { cause: error, phase });
  }
  if (
    lowerMessage.includes("websocket closed") ||
    lowerMessage.includes("websocket error") ||
    lowerMessage.includes("websocket is not open")
  ) {
    return new TatTransportError("connection_lost", message, { cause: error, phase });
  }
  if (
    lowerMessage.includes("connection is not writable") ||
    lowerMessage.includes("connection closed before")
  ) {
    return new TatTransportError("proxy_unavailable", message, { cause: error, phase });
  }
  return new TatTransportError("fatal", message, {
    cause: error,
    phase,
    retryable: false,
  });
}
