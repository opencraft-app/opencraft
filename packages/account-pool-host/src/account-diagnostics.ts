import { createHash } from "node:crypto";

/** Never log provider messages: even errors may contain credentials. */
export function accountFailureDiagnostic(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const http = /^Codex usage refresh failed \(HTTP ([1-5][0-9]{2})\)$/u.exec(message);
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const reason = /refresh_token_reused|refresh token has already been used/iu.test(message) ? "refresh-token-reused"
    : /refresh_token_expired|refresh token (?:has )?expired/iu.test(message) ? "refresh-token-expired"
    : /refresh_token_revoked|refresh token (?:has been |was )?revoked/iu.test(message) ? "refresh-token-revoked"
    : /invalid_grant/iu.test(message) ? "oauth-invalid-grant"
    : /Skipping token refresh because auth changed after guarded reload/iu.test(message) ? "auth-changed-during-refresh"
    : /you have since logged out or signed in to another account/iu.test(message) ? "auth-changed-during-refresh"
    : /Your access token could not be refreshed/iu.test(message) ? "refresh-login-required"
    : /unsupported_country_region_territory/iu.test(message) ? "unsupported-region"
    : /workspace routing discovery unauthorized/iu.test(message) ? "workspace-routing-unauthorized"
    : /token refresh failed.*401|refresh.*401 Unauthorized/iu.test(message) ? "oauth-refresh-unauthorized"
    : message === "Codex account cannot refresh without a refresh token" ? "refresh-token-missing"
    : message === "Codex refresh changed account identity" ? "account-identity-mismatch"
    : message === "Account credentials are unavailable" ? "credential-unavailable"
    : message === "Shared credentials need renewal by their external owner" ? "external-renewal-required"
    : message.startsWith("Codex maintenance request timed out:") ? "maintenance-timeout"
    : message.startsWith("Codex maintenance process exited (") ? "maintenance-process-exited"
    : http ? "usage-http-error" : "unclassified";
  return { reason, upstreamStatus: http ? Number(http[1]) : null,
    code: typeof code === "string" && /^(?:EACCES|ENOENT|EPERM|ECONNRESET|ECONNREFUSED|ETIMEDOUT|SQLITE_[A-Z_]+|UND_ERR_[A-Z_]+)$/u.test(code) ? code : null,
    fingerprint: createHash("sha256").update(message).digest("hex").slice(0, 16) };
}
