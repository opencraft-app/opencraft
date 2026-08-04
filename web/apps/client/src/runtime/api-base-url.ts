import { normalizeApiBaseUrl } from "@raft-platform/client-core";

interface ApiBaseUrlInput {
  browserHostname?: string;
  browserOrigin?: string;
  environmentUrl?: string;
  search?: string;
}

const localBackend = "http://127.0.0.1:18080";

export function resolveApiBaseUrl(input: ApiBaseUrlInput): string {
  const browserOverride =
    input.search && isLoopbackHostname(input.browserHostname)
    ? new URLSearchParams(input.search).get("backend")
    : null;
  const deployedOrigin =
    input.browserOrigin && !isLoopbackHostname(input.browserHostname)
      ? input.browserOrigin
      : null;
  return normalizeApiBaseUrl(
    browserOverride || input.environmentUrl || deployedOrigin || localBackend,
  );
}

function isLoopbackHostname(hostname: string | undefined): boolean {
  const normalized = hostname?.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}
