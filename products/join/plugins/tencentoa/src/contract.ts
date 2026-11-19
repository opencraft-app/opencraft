/** Recognition only: not an installation/resource authorization grant. */
export interface TencentOaIdentity {
  readonly loginName: string;
  readonly staffId: string;
  readonly expiresAt: string;
}
/** Only reason codes and non-secret request metadata may cross the server boundary. */
export const TENCENTOA_SERVER_DIAGNOSTIC_REASONS = [
  "closed",
  "resolver_unauthenticated",
  "missing_key",
  "duplicate_header",
  "missing_tai_headers",
  "invalid_timestamp_or_signature_format",
  "clock_skew",
  "signature_mismatch",
  "invalid_jwe_format",
  "unsupported_jwe_header",
  "decrypt_failed",
  "invalid_payload",
  "identity_expired",
  "legacy_header_mismatch",
] as const;
export type TencentOaServerDiagnosticReason = (typeof TENCENTOA_SERVER_DIAGNOSTIC_REASONS)[number];
export interface TencentOaServerDiagnostic {
  readonly reason: TencentOaServerDiagnosticReason;
  readonly missingHeaders?: readonly string[];
  readonly presentHeaders?: readonly string[];
  readonly skewMs?: number;
}
export type TencentOaDiagnosticFailureKind =
  | "network_or_redirect"
  | "timeout"
  | "endpoint_404"
  | "http_error"
  | "invalid_json"
  | "invalid_schema"
  | "provider_mismatch"
  | "unauthenticated";
/** Sanitized client-side snapshot; never contains credentials, payloads or header values. */
export interface TencentOaDiagnostic {
  readonly checkedAt: string;
  readonly endpoint: string;
  readonly failureKind: TencentOaDiagnosticFailureKind;
  readonly httpStatus: number | null;
  readonly contentType: string | null;
  readonly serverReason: string | null;
  readonly serverDiagnostic: TencentOaServerDiagnostic | null;
  readonly errorName: string | null;
  readonly errorMessage: string | null;
  readonly origin: string | null;
  readonly pathname: string | null;
  readonly userAgent: string | null;
}
export interface TencentOaSessionResponse {
  readonly available: boolean;
  readonly identity: TencentOaIdentity | null;
  readonly diagnostic?: TencentOaServerDiagnostic | null;
}
export const TENCENTOA_READ_RECEIPTS_PATH = "/__opencraft_enterprise_identity/read-receipts";
export const TENCENTOA_SESSION_PATH = "/__opencraft_enterprise_identity/session";
export const TENCENTOA_PHOTO_PATH = "/__opencraft_enterprise_identity/photo/";
export const TENCENTOA_PROVIDER_ID = "tencentoa.identity.employee";
export const TENCENTOA_PARTICIPANTS_METHOD = "opencraft/ioa/thread-participants/list";
export const TENCENTOA_PARTICIPANTS_CHANGED = "opencraft/ioa/thread-participants/changed";
export interface TencentOaThreadParticipants {
  readonly threadId: string;
  readonly revision: number;
  readonly participants: readonly string[];
  /** True until this provider completes full native-history reconciliation; snapshot is provisional. */
  readonly pending?: boolean;
  /** Absent on older Hosts; null means no verified creation identity is known. */
  readonly creator?: string | null;
}
/** TAI's documented clock-skew grace, shared by server and client. */
export const TENCENTOA_CLOCK_SKEW_MS = 180_000;
export function identityValidUntil(identity: TencentOaIdentity): number {
  return Date.parse(identity.expiresAt) + TENCENTOA_CLOCK_SKEW_MS;
}

export const TENCENTOA_MODEL_DEFAULTS_PATH = "/__opencraft_enterprise_identity/model-defaults";
export const TENCENTOA_SSH_CREDENTIALS_PATH = "/__opencraft_enterprise_identity/ssh-credentials";
export interface EmployeeSshCredential {
  readonly username: string;
  readonly privateKey: string;
  readonly publicKey: string;
  readonly fingerprint: string;
}

export const TENCENTOA_ENVIRONMENT_PATH = "/__opencraft_enterprise_identity/environment-variables";
