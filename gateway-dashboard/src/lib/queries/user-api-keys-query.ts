import {
  type ApiKeyStatusFilter,
  toApiKeyStatusQueryParam,
} from "./api-key-status-filter";

export function getUserApiKeysQueryKey(userId: string, status: ApiKeyStatusFilter) {
  return ["users", userId, "api-keys", status] as const;
}

export function getUserApiKeysQueryParams(status: ApiKeyStatusFilter) {
  return {
    status: toApiKeyStatusQueryParam(status),
  };
}
