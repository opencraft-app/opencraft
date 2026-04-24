export type UserStatusFilter = "active" | "suspended" | "deleted" | "all";

export const DEFAULT_USER_STATUS_FILTER: UserStatusFilter = "active";

export function normalizeUserStatusFilter(value: string | undefined): UserStatusFilter {
  if (value === "active" || value === "suspended" || value === "deleted" || value === "all") {
    return value;
  }
  return DEFAULT_USER_STATUS_FILTER;
}

export function toUserStatusQueryParam(status: UserStatusFilter): "active" | "suspended" | "deleted" | undefined {
  if (status === "all") {
    return undefined;
  }
  return status;
}
