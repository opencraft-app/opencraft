import { EXTERNAL_CODEX_REAUTH_MESSAGE } from "./codex-auth-file.js";
import { createHash, randomUUID } from "node:crypto";
import type {
  CodexAccountFailure,
  CodexAccountFailureCode,
  CodexAccountMaintenanceView,
} from "@opencraft/appserver-protocol";

// No raw exception, provider body, URL, credential, email or filesystem path is
// admitted into this contract. The ID joins public feedback to allowlisted logs.
const descriptions: Record<CodexAccountFailureCode, string> = {
  "authorization-rejected":
    "Account authorization was rejected. Sign in again, or renew shared credentials with their external owner.",
  "credential-unavailable":
    "Account credentials are unavailable. Renew shared credentials with their external owner or sign in again.",
  "credential-expired":
    "The account credential has expired. Ask the external owner to run codex login on the host for shared credentials, or remove this account and use device-code login.",
  "renewal-incomplete": "Account renewal did not return a usable account credential.",
  "renewal-failed": "Account renewal failed. The previous credential has been kept.",
  "upstream-unavailable": "Account usage is temporarily unavailable. Try again later.",
  "request-timeout": "The account request timed out. Its result is not confirmed.",
  "service-unavailable": "The account service is temporarily unavailable.",
  "admission-fenced": "The account service is under maintenance. Try again after it resumes.",
  "invalid-request": "The account operation is not supported or its input is invalid.",
  "operation-failed": "The account operation failed. Its result is not confirmed.",
};

export class CodexAccountOperationError extends Error {
  constructor(readonly diagnostic: CodexAccountFailure) {
    super(`${descriptions[diagnostic.code]} [${diagnostic.code}; ${diagnostic.diagnosticId}]`);
    this.name = "CodexAccountOperationError";
  }
}

export function accountFailure(
  code: CodexAccountFailureCode,
  stage: CodexAccountFailure["stage"],
  retryable: boolean,
  httpStatus?: number,
  reason?: CodexAccountFailure["reason"],
): CodexAccountOperationError {
  return new CodexAccountOperationError({
    code,
    stage,
    retryable,
    occurredAt: Date.now(),
    diagnosticId: randomUUID(),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(reason ? { reason } : {}),
  });
}

export function classifyAccountFailure(
  error: unknown,
  stage: CodexAccountFailure["stage"],
): CodexAccountOperationError {
  if (error instanceof CodexAccountOperationError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "CodexCoreUnavailableError") return accountFailure("service-unavailable", stage, true);
  if (name === "AbortError" || name === "TimeoutError") return accountFailure("request-timeout", stage, true);
  // Recognize only explicit native maintenance classifications, never forward
  // their messages. Everything else stays an uncertain, retryable failure.
  const message = error instanceof Error ? error.message : "";
  if (
    message === EXTERNAL_CODEX_REAUTH_MESSAGE ||
    message === "Account credentials are unavailable" ||
    message === "Codex account cannot refresh without a refresh token"
  )
    return accountFailure("credential-unavailable", "renewal", false);
  if (message === "Codex refresh changed account identity")
    return accountFailure("renewal-incomplete", "renewal", false);
  if (/\b(?:refresh_token_reused|refresh_token_expired|refresh_token_invalidated|invalid_grant)\b/u.test(message)) {
    return accountFailure("authorization-rejected", stage, false);
  }
  if (/^Codex maintenance request timed out:/u.test(message)) return accountFailure("request-timeout", stage, true);
  const reasons: Record<string, NonNullable<CodexAccountFailure["reason"]>> = {
    ENOTFOUND: "dns",
    EAI_AGAIN: "dns",
    ECONNREFUSED: "connection-refused",
    ECONNRESET: "connection-reset",
    UND_ERR_SOCKET: "connection-reset",
    UND_ERR_CONNECT_TIMEOUT: "connection-timeout",
    ETIMEDOUT: "connection-timeout",
    CERT_HAS_EXPIRED: "tls",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls",
    SELF_SIGNED_CERT_IN_CHAIN: "tls",
    DEPTH_ZERO_SELF_SIGNED_CERT: "tls",
  };
  let current = error;
  let reason: CodexAccountFailure["reason"] = /^Codex maintenance process exited/u.test(message)
    ? "native-exit"
    : undefined;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string" && Object.hasOwn(reasons, record.code)) {
      reason = reasons[record.code];
      break;
    }
    current = record.cause;
  }
  return accountFailure(
    stage === "renewal" ? "renewal-failed" : stage === "usage" ? "upstream-unavailable" : "operation-failed",
    stage,
    true,
    undefined,
    reason,
  );
}

export function parseAccountFailure(value: unknown): CodexAccountFailure | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.code !== "string" ||
    !Object.hasOwn(descriptions, v.code) ||
    !["renewal", "usage", "operation"].includes(String(v.stage)) ||
    typeof v.retryable !== "boolean" ||
    typeof v.diagnosticId !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(v.diagnosticId) ||
    !Number.isSafeInteger(v.occurredAt) ||
    Number(v.occurredAt) < 0 ||
    (v.reason !== undefined &&
      ![
        "dns",
        "connection-refused",
        "connection-reset",
        "tls",
        "connection-timeout",
        "native-exit",
        "invalid-response",
      ].includes(String(v.reason))) ||
    (v.httpStatus !== undefined &&
      (!Number.isSafeInteger(v.httpStatus) || Number(v.httpStatus) < 100 || Number(v.httpStatus) > 599))
  )
    return null;
  return {
    code: v.code as CodexAccountFailureCode,
    stage: v.stage as CodexAccountFailure["stage"],
    retryable: v.retryable,
    occurredAt: Number(v.occurredAt),
    diagnosticId: v.diagnosticId,
    ...(v.httpStatus === undefined ? {} : { httpStatus: Number(v.httpStatus) }),
    ...(v.reason ? { reason: v.reason as CodexAccountFailure["reason"] } : {}),
  };
}

export function logAccountFailure(
  error: CodexAccountOperationError,
  context: { accountId?: string; operation?: string; durationMs?: number } = {},
): void {
  // Input context is projected, not spread: even an invalid account ID or method
  // cannot smuggle request data or secrets into diagnostics.
  const operation = context.operation?.replace(/^opencraft\/codex\/accounts\//u, "");
  const known = [
    "list",
    "refresh",
    "setEnabled",
    "setAllowCredits",
    "reorder",
    "remove",
    "import",
    "deviceLogin/start",
    "deviceLogin/poll",
    "deviceLogin/cancel",
    "resetCredits/list",
    "resetCredits/consume",
  ];
  console.warn(
    "[opencraft account-pool]",
    JSON.stringify({
      event: "account-operation-failed",
      ...error.diagnostic,
      ...(context.accountId
        ? { accountRef: createHash("sha256").update(context.accountId).digest("hex").slice(0, 12) }
        : {}),
      ...(operation ? { operation: known.includes(operation) ? operation : "unknown" } : {}),
      ...(Number.isFinite(context.durationMs) ? { durationMs: Math.max(0, Math.round(context.durationMs!)) } : {}),
    }),
  );
}

export function logAccountRecovery(
  accountId: string,
  confirmedAt: number,
  previous?: CodexAccountMaintenanceView,
): void {
  if (previous?.state === "ok") return;
  console.info(
    "[opencraft account-pool]",
    JSON.stringify({
      event: "account-check-recovered",
      accountRef: createHash("sha256").update(accountId).digest("hex").slice(0, 12),
      confirmedAt,
      ...(previous?.failure ? { recoveredDiagnosticId: previous.failure.diagnosticId } : {}),
    }),
  );
}
