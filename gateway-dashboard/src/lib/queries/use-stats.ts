import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import {
  normalizeUsageTrend,
  type ModelDailyDistribution,
  type ModelDistribution,
  type TrendDataPoint,
} from "@/lib/queries/stats-shape";

interface UsageStats {
  total_tokens: number;
  total_interactions: number;
  tokens_change_pct: number;
  interactions_change_pct: number;
}

interface UserStats {
  total: number;
  active: number;
  disabled: number;
  expired: number;
}

interface TopUser {
  id: string;
  user_id: string;
  nickname?: string;
  status: string;
  total_tokens: number;
  total_interactions: number;
}

interface TopUsersStats {
  days: number;
  limit: number;
  items: TopUser[];
}

interface TokenPool {
  total_distributed: number;
  total_consumed: number;
  global_remaining: number;
  consumed_change_7d_pct: number;
}

export function useUsageStats() {
  return useQuery({
    queryKey: ["stats", "usage"],
    queryFn: () => apiClient<UsageStats>("ai-gateway/stats/usage"),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useUserStats() {
  return useQuery({
    queryKey: ["stats", "users"],
    queryFn: () => apiClient<UserStats>("ai-gateway/stats/users"),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useTopUsers(limit: number = 5, days: number = 7) {
  return useQuery({
    queryKey: ["stats", "users", "top", limit, days],
    queryFn: () =>
      apiClient<TopUsersStats>("ai-gateway/stats/users/top", {
        params: { limit, days },
      }),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useTokenPool() {
  return useQuery({
    queryKey: ["stats", "token-pool"],
    queryFn: () => apiClient<TokenPool>("ai-gateway/stats/token-pool"),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useUsageTrend(period: "7d" | "30d" = "7d") {
  return useQuery({
    queryKey: ["stats", "usage-trend", period],
    queryFn: () =>
      apiClient<{
        period: string;
        granularity: string;
        data: TrendDataPoint[] | null;
        model_distribution: ModelDistribution[] | null;
        model_daily_distribution: Array<Omit<ModelDailyDistribution, "share"> & { share?: number | null }> | null;
      }>("ai-gateway/stats/usage/trend", {
        params: { period, granularity: "daily" },
      }).then(normalizeUsageTrend),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}
