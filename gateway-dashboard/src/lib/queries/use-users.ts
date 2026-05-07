import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { type ApiKeyStatusFilter } from "@/lib/queries/api-key-status-filter";
import { getUserApiKeysQueryKey, getUserApiKeysQueryParams } from "@/lib/queries/user-api-keys-query";
import {
  buildUserUsageLogsQueryParams,
  getUserUsageLogsQueryKey,
  type UserUsageLogsFilters,
} from "@/lib/queries/user-usage-logs-query";
import { type UserStatusFilter, toUserStatusQueryParam } from "@/lib/queries/user-status-filter";
import { normalizeUserUsage } from "@/lib/queries/user-usage-chart";

// User 来自后端 API 响应
export interface User {
  id: string;
  user_id: string;
  phone: string;
  nickname?: string;
  status: string;
  current_plan?: string;
  token_balance?: number;
  is_unlimited?: boolean;
  created_at: string;
  updated_at?: string;
}

// UserDetail 来自 GET /admin/users/:user_id
export interface UserDetail extends User {
  subscription?: Subscription;
  plan?: Plan;
}

interface Subscription {
  id: string;
  plan_id: string;
  token_balance: number;
  status: string;
  period_start: string;
  period_end: string;
}

interface Plan {
  id: string;
  name: string;
  monthly_tokens: number;
}

interface ApiKey {
  id: string;
  key_prefix: string;
  status: string;
  created_at: string;
  last_used_at: string;
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

interface UserUsage {
  user_id: string;
  days: number;
  daily: { date: string; total_tokens: number; total_interactions: number }[];
  total_tokens: number;
  total_interactions: number;
}

export interface UserUsageLogItem {
  created_at: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  request_id: string;
  status_code: number;
  latency_ms: number;
  source: string;
}

interface UserUsageLogsSummary {
  total_requests: number;
  total_tokens: number;
}

export interface UserUsageLogsResponse {
  items: UserUsageLogItem[];
  total: number;
  page: number;
  page_size: number;
  summary: UserUsageLogsSummary;
}

export function useUsers(page: number = 1, pageSize: number = 20, search?: string, status?: UserStatusFilter) {
  return useQuery({
    queryKey: ["users", page, pageSize, search, status],
    queryFn: async () => {
      const raw = await apiClient<PaginatedResponse<User> | { users: User[]; total: number; page: number; page_size: number }>(
        "ai-gateway/users",
        { params: { page, page_size: pageSize, search, status: status ? toUserStatusQueryParam(status) : undefined } }
      );
      // 兼容新旧响应格式
      if ("items" in raw) return raw as PaginatedResponse<User>;
      const res = raw as { users: User[]; total: number; page: number; page_size: number };
      return { items: res.users ?? [], total: res.total ?? 0, page: res.page ?? 1, page_size: res.page_size ?? pageSize };
    },
  });
}

export function useUser(userId: string) {
  return useQuery({
    queryKey: ["users", userId],
    queryFn: () => apiClient<UserDetail>(`ai-gateway/users/${userId}`),
    enabled: !!userId,
  });
}

export function useUserSubscriptions(userId: string) {
  return useQuery({
    queryKey: ["users", userId, "subscriptions"],
    queryFn: async () => {
      try {
        // 后端返回单个 Subscription 对象，非分页
        const sub = await apiClient<Subscription>(`ai-gateway/users/${userId}/subscriptions`);
        return { items: sub ? [sub] : [], total: sub ? 1 : 0, page: 1, page_size: 1 };
      } catch {
        // 无活跃订阅时后端返回 404
        return { items: [] as Subscription[], total: 0, page: 1, page_size: 1 };
      }
    },
    enabled: !!userId,
  });
}

export { getUserApiKeysQueryKey, getUserApiKeysQueryParams } from "@/lib/queries/user-api-keys-query";

export function useUserApiKeys(userId: string, status: ApiKeyStatusFilter) {
  return useQuery({
    queryKey: getUserApiKeysQueryKey(userId, status),
    queryFn: async () => {
      // 后端返回 { api_keys: [...] }，非分页，使用 is_active 布尔值
      const raw = await apiClient<{ api_keys: Array<ApiKey & { is_active?: boolean }> }>(
        `ai-gateway/users/${userId}/api-keys`,
        { params: getUserApiKeysQueryParams(status) }
      );
      const keys = (raw.api_keys ?? []).map((k) => ({
        ...k,
        status: k.status || (k.is_active !== false ? "active" : "revoked"),
      }));
      return { items: keys, total: keys.length, page: 1, page_size: keys.length };
    },
    enabled: !!userId,
  });
}

export function useUserUsage(userId: string, days: number = 7) {
  return useQuery({
    queryKey: ["users", userId, "usage", days],
    queryFn: () =>
      apiClient<UserUsage>(`ai-gateway/users/${userId}/usage`, {
        params: { days },
      }).then((usage) => normalizeUserUsage(usage)),
    enabled: !!userId,
  });
}

export function useUserUsageLogs(userId: string, filters: UserUsageLogsFilters) {
  const query = buildUserUsageLogsQueryParams(filters);

  return useQuery({
    queryKey: getUserUsageLogsQueryKey(userId, filters),
    queryFn: () =>
      apiClient<UserUsageLogsResponse>(`ai-gateway/users/${userId}/usage-logs`, {
        params: query.params,
      }),
    enabled: !!userId && query.enabled,
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, ...data }: { userId: string; status?: string }) =>
      apiClient(`ai-gateway/users/${userId}`, { method: "PUT", body: data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiClient(`ai-gateway/users/${userId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

export function useAdjustTokens() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ subscriptionId, delta }: { subscriptionId: string; delta: number }) =>
      apiClient(`ai-gateway/subscriptions/${subscriptionId}/tokens`, {
        method: "PUT",
        body: { delta },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

export function useSubscribeUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      userId,
      planId,
      periodMonths = 1,
      mode = "reset",
    }: {
      userId: string;
      planId: string;
      periodMonths?: number;
      mode?: "reset" | "deduct_used";
    }) =>
      apiClient(`ai-gateway/users/${userId}/subscriptions`, {
        method: "POST",
        body: { plan_id: planId, period_months: periodMonths, mode },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

export function useCancelSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiClient(`ai-gateway/users/${userId}/subscriptions`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiClient<{ api_key: string; key_id: string; key_prefix: string; name: string; created_at: string }>(
        `ai-gateway/users/${userId}/api-keys`,
        { method: "POST", body: {} }
      ),
    onSuccess: (_, userId) => {
      queryClient.invalidateQueries({ queryKey: ["users", userId, "api-keys"] });
    },
  });
}
