import type { CodexAccountFailure, CodexAccountFailureCode, CodexAccountView } from "@opencraft/appserver-protocol";

export const accountFailureMessages: Record<CodexAccountFailureCode, { id: string; defaultMessage: string }> = {
  "authorization-rejected": {
    id: "codexAccounts.failure.authorizationRejected",
    defaultMessage: "Authorization was rejected. Sign in again.",
  },
  "credential-unavailable": {
    id: "codexAccounts.failure.credentialUnavailable",
    defaultMessage: "Account credentials are unavailable. Renew them with their owner or sign in again.",
  },
  "credential-expired": {
    id: "codexAccounts.failure.credentialExpired",
    defaultMessage: "The credential has expired. Renew it with its owner or sign in again.",
  },
  "renewal-incomplete": {
    id: "codexAccounts.failure.renewalIncomplete",
    defaultMessage: "Renewal did not return a usable credential. The account has not recovered.",
  },
  "renewal-failed": {
    id: "codexAccounts.failure.renewalFailed",
    defaultMessage: "Credential renewal failed. The previous credential has been kept.",
  },
  "upstream-unavailable": {
    id: "codexAccounts.failure.upstreamUnavailable",
    defaultMessage: "Usage is temporarily unavailable. This does not mean you are signed out.",
  },
  "request-timeout": {
    id: "codexAccounts.failure.requestTimeout",
    defaultMessage: "The account request timed out. Its result is not confirmed.",
  },
  "service-unavailable": {
    id: "codexAccounts.failure.serviceUnavailable",
    defaultMessage: "The account service is temporarily unavailable. Try again later.",
  },
  "admission-fenced": {
    id: "codexAccounts.failure.admissionFenced",
    defaultMessage: "The account service is under maintenance. Try again after it resumes.",
  },
  "invalid-request": {
    id: "codexAccounts.failure.invalidRequest",
    defaultMessage: "This account operation is not supported or its input is invalid.",
  },
  "operation-failed": {
    id: "codexAccounts.failure.operationFailed",
    defaultMessage: "The operation did not finish. Check its result before submitting it again.",
  },
};

/** Validate the public projection independently from the trusted native owner. */
export function accountFailureFromRpc(error: unknown): CodexAccountFailure | null {
  const data =
    error && typeof error === "object" ? (error as { data?: { codexAccountFailure?: unknown } }).data : undefined;
  const value = data?.codexAccountFailure;
  if (!value || typeof value !== "object") return null;
  const v = value as CodexAccountFailure;
  if (
    !Object.hasOwn(accountFailureMessages, v.code) ||
    !["renewal", "usage", "operation"].includes(v.stage) ||
    typeof v.diagnosticId !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(v.diagnosticId) ||
    typeof v.retryable !== "boolean" ||
    !Number.isSafeInteger(v.occurredAt) ||
    v.occurredAt < 0 ||
    (v.reason !== undefined &&
      ![
        "dns",
        "connection-refused",
        "connection-reset",
        "tls",
        "connection-timeout",
        "native-exit",
        "invalid-response",
      ].includes(v.reason)) ||
    (v.httpStatus !== undefined && (!Number.isSafeInteger(v.httpStatus) || v.httpStatus < 100 || v.httpStatus > 599))
  )
    return null;
  return {
    code: v.code,
    stage: v.stage,
    diagnosticId: v.diagnosticId,
    retryable: v.retryable,
    occurredAt: v.occurredAt,
    ...(v.httpStatus === undefined ? {} : { httpStatus: v.httpStatus }),
    ...(v.reason ? { reason: v.reason } : {}),
  };
}

export interface AccountActionFailure {
  readonly action: string;
  readonly failure: CodexAccountFailure | null;
  readonly baselineSuccessAt: number;
  readonly adminRequired: boolean;
}

export function refreshFailureResolved(error: AccountActionFailure, account: CodexAccountView): boolean {
  const observation = account.maintenance;
  return (
    error.action === "refresh" &&
    !error.adminRequired &&
    observation?.state === "ok" &&
    observation.lastSuccessAt !== null &&
    observation.lastSuccessAt > error.baselineSuccessAt &&
    (!error.failure || observation.lastSuccessAt >= error.failure.occurredAt)
  );
}

export function accountFeedbackStatus(account: CodexAccountView): CodexAccountView["status"] {
  if (!account.enabled) return "disabled";
  if (account.maintenance?.state === "checking" || account.maintenance?.state === "unverified") return "held";
  if (account.maintenance?.state === "error")
    return account.maintenance.failure?.retryable === false ? "error" : "held";
  return account.status;
}
