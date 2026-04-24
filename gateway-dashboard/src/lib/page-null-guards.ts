export interface UsageLogsSummaryLike {
  total_requests?: number | null;
  total_tokens?: number | null;
}

export function ensureItems<T>(items: T[] | null | undefined): T[] {
  return Array.isArray(items) ? items : [];
}

export function ensureUsageLogsSummary(summary: UsageLogsSummaryLike | null | undefined) {
  return {
    total_requests: summary?.total_requests ?? 0,
    total_tokens: summary?.total_tokens ?? 0,
  };
}
