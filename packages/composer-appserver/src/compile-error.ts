export class SubmitCompileError extends Error {
  readonly code: "ASSET_NOT_READY" | "INVALID_JSON" | "EMPTY_INPUT" | "CAPABILITY_UNAVAILABLE" | "UNSUPPORTED_INPUT" | "INVALID_INPUT_IMAGE";

  constructor(code: SubmitCompileError["code"], message: string) {
    super(message);
    this.name = "SubmitCompileError";
    this.code = code;
  }
}
