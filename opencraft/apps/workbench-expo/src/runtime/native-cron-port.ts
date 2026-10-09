/** Platform port for the shared frontend Cron client. Every operation carries its own credentials. */
type NativeCronTarget = {
  apiBase: string;
  token: string;
  region: "cn" | "intl";
  onUnauthorized(): void;
};

function nativeTarget(value: unknown): NativeCronTarget {
  if (typeof value !== "object" || value === null || !("apiBase" in value)
    || !("token" in value) || !("region" in value) || !("onUnauthorized" in value)) {
    throw new Error("Cron request is missing its native account context");
  }
  return value as NativeCronTarget;
}

export function resolveConfiguredAuthApiBaseUrl(target?: unknown): string {
  return nativeTarget(target).apiBase;
}

export function createDebugExecRequestBody(command: string, target?: unknown): {
  command: string;
  run_as_user: "agentuser";
  execution_backend?: "tat";
} {
  return nativeTarget(target).region === "intl"
    ? { command, run_as_user: "agentuser", execution_backend: "tat" }
    : { command, run_as_user: "agentuser" };
}

export const AUTH_UNAUTHORIZED_EVENT = "lightclaw:auth-unauthorized";
export function readStoredAuthToken(target?: unknown): string { return nativeTarget(target).token; }
export function writeStoredAuthToken(token: string | null, target?: unknown): void {
  if (token === null) nativeTarget(target).onUnauthorized();
}
