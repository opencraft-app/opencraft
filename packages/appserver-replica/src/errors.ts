export type ReplicaErrorCode =
  | "NOT_OPEN"
  | "INVALID_STATE"
  | "STALE_CURSOR"
  | "COMMAND_CONFLICT"
  | "PROTOCOL_ERROR"
  | "STORAGE_ERROR"
  | "DISPOSED";

export class ReplicaError extends Error {
  constructor(
    readonly code: ReplicaErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ReplicaError";
  }
}
