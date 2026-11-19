export class BrowserToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly outcome?: "not-dispatched" | "unknown",
  ) {
    super(message);
    this.name = "BrowserToolError";
  }
}
