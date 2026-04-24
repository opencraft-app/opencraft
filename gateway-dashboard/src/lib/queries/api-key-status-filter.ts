export type ApiKeyStatusFilter = "active" | "revoked" | "all";

export const DEFAULT_API_KEY_STATUS_FILTER: ApiKeyStatusFilter = "active";

export function normalizeApiKeyStatusFilter(value: string | undefined): ApiKeyStatusFilter {
  if (value === "active" || value === "revoked" || value === "all") {
    return value;
  }
  return DEFAULT_API_KEY_STATUS_FILTER;
}

export function toApiKeyStatusQueryParam(status: ApiKeyStatusFilter): "active" | "revoked" | undefined {
  if (status === "all") {
    return undefined;
  }
  return status;
}
