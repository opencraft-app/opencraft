import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

export interface AdminShadowAccount {
  user_id: string;
  country_code: string;
  phone_number: string;
  is_register_shadow_account: boolean;
  is_shadow_account_basic_auth: boolean;
  is_standard_realname_auth: boolean;
  shadow_user_name: string;
  uin: string;
  owner_uin: string;
  appid: string;
  instance_id: string;
  created_at: string;
  bound_at?: string;
}

interface ShadowAccountListResponse {
  items: AdminShadowAccount[];
  total: number;
  page: number;
  page_size: number;
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
      apiClient<ShadowAccountListResponse>("shadow/accounts", {
        params: {
          search: filters.search,
          page: filters.page,
          page_size: filters.pageSize,
        },
      }),
    enabled: filters.enabled ?? true,
  });
}
