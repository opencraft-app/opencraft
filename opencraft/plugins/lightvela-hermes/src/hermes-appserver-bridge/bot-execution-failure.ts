import type { AppServerBotDomainErrorData } from "@opencraft/appserver-protocol";

function failureText(value: unknown, depth = 0): string {
  if (typeof value === "string") return value;
  if (depth >= 3 || typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  return ["message", "error", "detail", "reason", "data", "errorSurface", "error_surface", "layer", "code"]
    .map((key) => failureText(record[key], depth + 1))
    .filter(Boolean)
    .join(" ");
}

export function classifyHermesBotExecutionFailure(input: {
  readonly reasonCode?: unknown;
  readonly error?: unknown;
}): AppServerBotDomainErrorData {
  const reason = typeof input.reasonCode === "string" ? input.reasonCode : "";
  const message = failureText(input.error).toLowerCase();
  if (reason === "provider_quota_limit" || /\b402\b|\b401008\b|\bbilling\b|quota|out of funds|insufficient (?:credits?|balance)|额度不足/u.test(message)) {
    return { code: "BOT_PROVIDER_QUOTA_LIMIT", retryable: false };
  }
  if (reason === "missing_config" || /unknown provider|not configured|no api key|missing api key/u.test(message)) {
    return { code: "BOT_MODEL_NOT_CONFIGURED", retryable: false };
  }
  if (reason === "provider_auth_or_access" || /\b401\b|\b403\b|unauthorized|invalid api key/u.test(message)) {
    return { code: "BOT_PROVIDER_AUTH_REQUIRED", retryable: false };
  }
  if (reason === "turn_deadline_exceeded" || /timed? out|deadline exceeded/u.test(message)) {
    return { code: "BOT_RESPONSE_TIMEOUT", retryable: true };
  }
  return { code: "BOT_EXECUTION_FAILED", retryable: true };
}
