import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

export interface RateLimitRule {
  window: string;
  max_requests: number;
  label: string;
}

export interface Plan {
  id: string;
  name: string;
  monthly_tokens: number;
  rate_limits: RateLimitRule[];
  allowed_models: string[];
  token_multipliers: Record<string, number>;
  period_value: number;
  period_unit: 'days' | 'months';
  created_at: string;
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

interface PlanInput {
  name: string;
  monthly_tokens: number;
  rate_limits: RateLimitRule[];
  allowed_models: string[];
  token_multipliers: Record<string, number>;
  period_value: number;
  period_unit: 'days' | 'months';
}

export function usePlans() {
  return useQuery({
    queryKey: ["plans"],
    queryFn: async () => {
      const raw = await apiClient<PaginatedResponse<Plan> | { plans: Plan[] }>("ai-gateway/plans");
      // 兼容新旧响应格式
      if ("items" in raw) return raw as PaginatedResponse<Plan>;
      const plans = (raw as { plans: Plan[] }).plans ?? [];
      return { items: plans, total: plans.length, page: 1, page_size: plans.length };
    },
  });
}

export function usePlan(id: string) {
  return useQuery({
    queryKey: ["plans", id],
    queryFn: () => apiClient<Plan>(`ai-gateway/plans/${id}`),
    enabled: !!id,
  });
}

export function useCreatePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: PlanInput) =>
      apiClient<Plan>("ai-gateway/plans", { method: "POST", body: data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plans"] });
    },
  });
}

export function useUpdatePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: PlanInput & { id: string }) =>
      apiClient<Plan>(`ai-gateway/plans/${id}`, { method: "PUT", body: data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plans"] });
    },
  });
}

export function useDeletePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient(`ai-gateway/plans/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plans"] });
    },
  });
}
