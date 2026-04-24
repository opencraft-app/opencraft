import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { type ApiKeyStatusFilter, toApiKeyStatusQueryParam } from "@/lib/queries/api-key-status-filter";

interface ApiKeyItem {
  id: string;
  key_prefix: string;
  user_id: string;
  gateway_user_id: string;
  user_phone: string;
  user_nickname: string;
  status: string;
  created_at: string;
  last_used_at: string;
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
  active_count: number;
  page: number;
  page_size: number;
}

export function useApiKeys(page: number = 1, search?: string, status?: ApiKeyStatusFilter) {
  return useQuery({
    queryKey: ["api-keys", page, search, status],
    queryFn: () =>
      apiClient<PaginatedResponse<ApiKeyItem>>("ai-gateway/api-keys", {
        params: { page, page_size: 20, search, status: status ? toApiKeyStatusQueryParam(status) : undefined },
      }),
  });
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient(`ai-gateway/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}
