import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

export interface Provider {
  id: string;
  name: string;
  provider_type: string;
  model_discovery_protocol: string;
  base_url: string;
  api_key: string;
  status: string;
  priority: number;
  weight: number;
  health_check_url: string;
  last_heartbeat: string | null;
  registration_source: string;
  total_quota: number;
  used_quota: number;
  supported_models: string[] | null;
  created_at: string;
  updated_at: string;
}

interface ProviderUsage {
  used_quota: number;
  total_quota: number;
  request_count: number;
  last_used_at: string;
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
  active_count: number;
  page: number;
  page_size: number;
}

interface ProviderInput {
  name: string;
  provider_type: string;
  model_discovery_protocol: string;
  api_key?: string;
  base_url?: string;
  total_quota: number;
  priority: number;
  weight?: number;
  health_check_url?: string;
  status?: string;
  supported_models?: string[];
}

export interface ProviderValidationInput {
  provider_id?: string;
  provider_type: string;
  api_key?: string;
  base_url: string;
  health_check_url?: string;
}

export interface ProviderValidationResult {
  ok: boolean;
  message: string;
  endpoint: string;
  status_code?: number;
  latency_ms: number;
  error_type?: string;
  response_excerpt?: string;
  used_saved_api_key: boolean;
}

export interface ProviderModelDiscoveryInput {
  provider_id?: string;
  model_discovery_protocol: string;
  api_key?: string;
  base_url: string;
  health_check_url?: string;
}

export interface ProviderModelDiscoveryResult {
  ok: boolean;
  message: string;
  endpoint: string;
  models: string[];
  raw_count: number;
  normalized_count: number;
  status_code?: number;
  error_type?: string;
  response_excerpt?: string;
  used_saved_api_key: boolean;
}

export interface ProviderModelRequestValidationInput {
  provider_id?: string;
  model_discovery_protocol: string;
  api_key?: string;
  base_url: string;
  model: string;
}

export interface ProviderModelRequestValidationResult {
  ok: boolean;
  message: string;
  endpoint: string;
  model: string;
  status_code?: number;
  latency_ms: number;
  error_type?: string;
  response_excerpt?: string;
  used_saved_api_key: boolean;
}

export function useProviders() {
  return useQuery({
    queryKey: ["providers"],
    queryFn: async () => {
      const raw = await apiClient<PaginatedResponse<Provider>>("ai-gateway/providers");
      return raw;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useProvider(id: string) {
  return useQuery({
    queryKey: ["providers", id],
    queryFn: () => apiClient<Provider>(`ai-gateway/providers/${id}`),
    enabled: !!id,
  });
}

export function useProviderUsage(id: string) {
  return useQuery({
    queryKey: ["providers", id, "usage"],
    queryFn: () => apiClient<ProviderUsage>(`ai-gateway/providers/${id}/usage`),
    enabled: !!id,
  });
}

export function useCreateProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ProviderInput) =>
      apiClient<Provider>("ai-gateway/providers", { method: "POST", body: data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}

export function useUpdateProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: ProviderInput & { id: string }) =>
      apiClient<Provider>(`ai-gateway/providers/${id}`, { method: "PUT", body: data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}

export function useValidateProvider() {
  return useMutation({
    mutationFn: (data: ProviderValidationInput) =>
      apiClient<ProviderValidationResult>("ai-gateway/providers/validate", {
        method: "POST",
        body: data,
      }),
  });
}

export function useDiscoverProviderModels() {
  return useMutation({
    mutationFn: (data: ProviderModelDiscoveryInput) =>
      apiClient<ProviderModelDiscoveryResult>("ai-gateway/providers/discover-models", {
        method: "POST",
        body: data,
      }),
  });
}

export function useValidateProviderModelRequest() {
  return useMutation({
    mutationFn: (data: ProviderModelRequestValidationInput) =>
      apiClient<ProviderModelRequestValidationResult>("ai-gateway/providers/validate-model-request", {
        method: "POST",
        body: data,
      }),
  });
}
