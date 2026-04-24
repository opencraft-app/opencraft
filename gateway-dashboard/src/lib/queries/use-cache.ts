import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

// 缓存配置接口
export interface CacheConfig {
  enabled: boolean;
  ttl_seconds: number;
  similarity_threshold: number;
  max_response_bytes: number;
  scope_mode: string;
  max_cache_entries: number;
  embedding_model: string;
  embedding_base_url: string;
  embedding_api_key: string;
}

// 缓存统计接口
export interface CacheStats {
  total_hits: number;
  total_misses: number;
  hit_rate: number;
  tokens_saved: number;
  cache_entries: number;
  today_hits: number;
  today_misses: number;
}

// 读取缓存配置
export function useCacheConfig() {
  return useQuery({
    queryKey: ["cache", "config"],
    queryFn: () => apiClient<CacheConfig>("ai-gateway/cache/config"),
    staleTime: 30 * 1000,
  });
}

// 更新缓存配置
export function useUpdateCacheConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<CacheConfig>) =>
      apiClient<CacheConfig>("ai-gateway/cache/config", {
        method: "PUT",
        body: data,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["cache", "config"], data);
    },
  });
}

// 读取缓存统计
export function useCacheStats() {
  return useQuery({
    queryKey: ["cache", "stats"],
    queryFn: () => apiClient<CacheStats>("ai-gateway/cache/stats"),
    staleTime: 10 * 1000,
    refetchInterval: 30 * 1000,
  });
}

// 测试 Embedding 提供商连通性
export function useTestEmbedding() {
  return useMutation({
    mutationFn: () =>
      apiClient<{ ok: boolean; latency_ms: number }>("ai-gateway/cache/test-embedding", {
        method: "POST",
      }),
  });
}

// 清除全部缓存
export function useClearCache() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiClient<{ message: string }>("ai-gateway/cache", {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cache", "stats"] });
    },
  });
}
