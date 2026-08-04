import { normalizeApiBaseUrl } from "@raft-platform/client-core";

interface ApiBaseUrlInput {
  browserHostname?: string;
  browserOrigin?: string;
  environmentUrl?: string;
  search?: string;
}

export function resolveApiBaseUrl(input: ApiBaseUrlInput): string {
  const browserOverride =
    input.search && isLoopbackHostname(input.browserHostname)
      ? new URLSearchParams(input.search).get("backend")
      : null;
  const baseUrl = browserOverride || input.environmentUrl || input.browserOrigin;
  if (!baseUrl) {
    throw new Error("Web 客户端无法确定平台 API 地址");
  }
  return normalizeApiBaseUrl(baseUrl);
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
