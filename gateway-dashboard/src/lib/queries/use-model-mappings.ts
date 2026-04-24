import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

export interface ModelMapping {
  id: string;
  model_pattern: string;
  provider_id: string;
  priority: number;
  weight: number;
  is_active: boolean;
  created_at: string;
  strategy_mode?: string | null;        // "loadbalance" / "fallback" / null(继承全局)
  retry_attempts?: number | null;       // 重试次数覆盖
  on_status_codes?: number[] | null;    // 策略触发状态码覆盖
  override_params?: Record<string, unknown> | null; // 目标提供商参数覆盖
  provider?: {
    id: string;
    name: string;
    provider_type: string;
  };
}

export interface ModelMappingInput {
  model_pattern: string;
  provider_id: string;
  priority?: number;
  weight?: number;
  is_active?: boolean;
  strategy_mode?: string | null;
  retry_attempts?: number | null;
  on_status_codes?: number[] | null;
  override_params?: Record<string, unknown> | null;
}

export interface ModelMappingUpdateInput {
  model_pattern?: string;
  provider_id?: string;
  priority?: number;
  weight?: number;
  is_active?: boolean;
  strategy_mode?: string | null;
  retry_attempts?: number | null;
  on_status_codes?: number[] | null;
  override_params?: Record<string, unknown> | null;
}

interface ResolveResult {
  model: string;
  providers: Array<{
    id: string;
    name: string;
    provider_type: string;
    base_url: string;
    priority: number;
    weight: number;
    status: string;
  }>;
  mismatches?: Array<{
    provider_id: string;
    provider_name: string;
    reason: string;
    source: string;
  }>;
  count: number;
  fallback?: boolean;
  message?: string;
}

export function useModelMappings() {
  return useQuery({
    queryKey: ["model-mappings"],
    queryFn: async () => {
      const raw = await apiClient<{ items: ModelMapping[]; total: number }>("ai-gateway/model-mappings");
      return raw;
    },
    staleTime: 30_000,
  });
}

export function useCreateModelMapping() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ModelMappingInput) =>
      apiClient<ModelMapping>("ai-gateway/model-mappings", { method: "POST", body: data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["model-mappings"] });
    },
  });
}

export function useDeleteModelMapping() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient(`ai-gateway/model-mappings/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["model-mappings"] });
    },
  });
}

export function useUpdateModelMapping() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ModelMappingUpdateInput }) =>
      apiClient<ModelMapping>(`ai-gateway/model-mappings/${id}`, { method: "PUT", body: data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["model-mappings"] });
    },
  });
}

export function useResolveModel() {
  return useMutation({
    mutationFn: (model: string) =>
      apiClient<ResolveResult>(`ai-gateway/model-mappings/resolve?model=${encodeURIComponent(model)}`),
  });
}
