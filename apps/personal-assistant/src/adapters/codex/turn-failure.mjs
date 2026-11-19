// Never persist provider error messages: they may contain prompts, URLs or credentials.
const codes = new Set([
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "usageLimitExceeded",
  "rateLimitExceeded",
  "serverOverloaded",
  "cyberPolicy",
  "misalignmentPolicyViolation",
  "internalServerError",
  "unauthorized",
  "badRequest",
  "threadRollbackFailed",
  "sandboxError",
  "other",
]);
const httpCodes = new Set([
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);
export function nativeTurnFailure(turn, telemetry, role) {
  const info = turn?.error?.codexErrorInfo;
  let category = "other",
    httpStatus;
  if (typeof info === "string" && codes.has(info)) category = info;
  else if (info && typeof info === "object") {
    const key = Object.keys(info).find((k) => httpCodes.has(k));
    if (key) {
      category = key;
      const status = info[key]?.httpStatusCode;
      if (Number.isInteger(status) && status >= 100 && status <= 599) httpStatus = status;
    }
  }
  const status = ["failed", "interrupted"].includes(turn?.status) ? turn.status : "unknown";
  const error = Object.assign(
    new Error(`Codex turn ${status} (${category}${httpStatus ? `, HTTP ${httpStatus}` : ""})`),
    {
      code: "CODEX_TURN_FAILED",
      nativeCategory: category,
      ...(httpStatus ? { httpStatus } : {}),
      ...(httpStatus === 429 || category === "rateLimitExceeded"
        ? { modelFailure: { kind: "rate_limit", retryAt: Date.now() + 5000 } }
        : {}),
    },
  );
  telemetry?.event("codex.turn_failed", {
    "app.model_role": role,
    "app.native_error": category,
    "app.native_status": status,
    ...(httpStatus ? { "http.response.status_code": httpStatus } : {}),
  });
  return error;
}

/** Optional Host metadata is scoped to this Bot/purpose; provider bodies never cross this boundary. */
export async function enrichModelFailure(error, readFailure, purpose) {
  if (error?.modelFailure?.kind !== "rate_limit" || !readFailure) return error;
  try {
    const value = await readFailure(purpose);
    if (value?.kind === "quota_exhausted") error.modelFailure = { kind: "quota_exhausted" };
    else if (value?.httpStatus === 429 && Number.isSafeInteger(value.retryAt))
      error.modelFailure = { kind: "rate_limit", retryAt: value.retryAt };
  } catch {
    /* Observation failure cannot replace the original native error. */
  }
  return error;
}
