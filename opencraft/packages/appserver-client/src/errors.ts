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
