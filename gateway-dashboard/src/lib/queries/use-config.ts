import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

export interface StrategyConfig {
  mode: string;                    // "loadbalance" | "fallback"
  on_status_codes: number[];       // 策略触发状态码
  retry_attempts: number;           // 0-5
  retry_status_codes: number[];    // retry 触发状态码
}

export interface UpdateStrategyPayload extends Partial<StrategyConfig> {
  default_model?: string;
}

export interface CircuitBreakerConfig {
  failure_threshold: number;
  cooldown_duration_s: number;
}

export interface RoutingConfig {
  failure_threshold: number;
  cooldown_duration_s: number;
  default_model: string;
  strategy: StrategyConfig;
}

// 读取路由配置
export function useRoutingConfig() {
  return useQuery({
    queryKey: ["config", "routing"],
    queryFn: () => apiClient<RoutingConfig>("ai-gateway/config/routing"),
    staleTime: 30 * 1000,
    refetchInterval: false,
  });
}

// 更新路由策略和默认模型（PUT /admin/config/routing/strategy）
export function useUpdateStrategy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: UpdateStrategyPayload) =>
      apiClient<RoutingConfig>("ai-gateway/config/routing/strategy", {
        method: "PUT",
        body: data,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData<RoutingConfig>(["config", "routing"], data);
    },
  });
}

// 更新熔断器配置（PUT /admin/config/routing/circuit-breaker）
export function useUpdateCircuitBreaker() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<CircuitBreakerConfig>) =>
      apiClient<CircuitBreakerConfig>("ai-gateway/config/routing/circuit-breaker", {
        method: "PUT",
        body: data,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData<RoutingConfig>(["config", "routing"], (old) => {
        if (!old) return old;
        return { ...old, ...data };
      });
    },
  });
}
