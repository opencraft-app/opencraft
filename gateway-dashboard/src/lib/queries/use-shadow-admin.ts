import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

export interface AdminShadowAccount {
  userId: string;
  phone: string;
  realnameVerified: boolean;
  shadowUserName: string;
  uin: string;
  ownerUin: string;
  appId: string;
  bindingStatus: string;
  basicAuthStatus: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  userCreatedAt: string;
  bindingCreatedAt: string;
  bindingUpdatedAt: string;
}

interface ShadowAccountListResponse {
  items: AdminShadowAccount[];
  total: number;
  page: number;
  pageSize: number;
}

interface ShadowAccountFilters {
  search?: string;
  page: number;
  pageSize: number;
  enabled?: boolean;
}

export function useShadowAdminAccounts(filters: ShadowAccountFilters) {
  return useQuery({
    queryKey: ["shadow-admin", "accounts", filters.search, filters.page, filters.pageSize],
    queryFn: () =>
      apiClient<ShadowAccountListResponse>("auth/shadow-accounts", {
        params: {
          search: filters.search,
          page: filters.page,
          page_size: filters.pageSize,
        },
      }),
    enabled: filters.enabled ?? true,
  });
}
