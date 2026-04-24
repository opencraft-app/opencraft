export type UserUsageLogsRange = "7d" | "30d" | "custom";

export interface UserUsageLogsFilters {
  range: UserUsageLogsRange;
  start?: string;
  end?: string;
  page: number;
  pageSize: number;
}

interface UserUsageLogsQueryResult {
  enabled: boolean;
  params: {
    range: UserUsageLogsRange;
    start?: string;
    end?: string;
    page: number;
    page_size: number;
  };
}

export function buildUserUsageLogsQueryParams(filters: UserUsageLogsFilters): UserUsageLogsQueryResult {
  const params = {
    range: filters.range,
    page: filters.page,
    page_size: filters.pageSize,
    ...(filters.start !== undefined ? { start: filters.start } : {}),
    ...(filters.end !== undefined ? { end: filters.end } : {}),
  };

  if (filters.range === "custom") {
    return {
      enabled: Boolean(filters.start && filters.end),
      params,
    };
  }

  return {
    enabled: true,
    params,
  };
}

export function getUserUsageLogsQueryKey(userId: string, filters: UserUsageLogsFilters) {
  return ["users", userId, "usage-logs", filters.range, filters.start ?? "", filters.end ?? "", filters.page, filters.pageSize] as const;
}

export function getUsageLogsStateForRangeChange(
  current: UserUsageLogsFilters,
  nextRange: UserUsageLogsRange,
): UserUsageLogsFilters {
  return {
    ...current,
    range: nextRange,
    page: 1,
  };
}

export function getUserUsageLogsColumns(showTechnicalFields: boolean): string[] {
  const baseColumns = [
    "请求时间",
    "模型",
    "请求次数",
    "Prompt Tokens",
    "Completion Tokens",
    "Total Tokens",
    "Request ID",
  ];

  if (!showTechnicalFields) {
    return baseColumns;
  }

  return [...baseColumns, "状态码", "延迟", "来源"];
}

export function getUserUsageLogsRangeLabel(filters: UserUsageLogsFilters): string {
  switch (filters.range) {
    case "7d":
      return "近 7 天";
    case "30d":
      return "近 30 天";
    case "custom":
      if (filters.start && filters.end) {
        return `${filters.start} 至 ${filters.end}`;
      }
      return "自定义";
    default:
      return filters.range;
  }
}
