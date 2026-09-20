import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

interface CreditEnvelope<T> {
  data: T;
}

const CREDIT_PACKAGES_QUERY_KEY = ["credit-admin", "packages"] as const;

export interface AdminCreditPackage {
  package_id: string;
  user_id: string;
  product_id: string;
  product_name: string;
  uin: string;
  app_id: number;
  deal_name: string;
  big_order_id: string;
  llm_gateway_plan_id: string;
  llm_subscription_id: string;
  llm_subscription_name: string;
  created_time: string;
  expired_time: string;
  isolated_time?: string | null;
  status: string;
  updated_time: string;
  credit_total: number;
  credit_used_total: number;
  credit_left: number;
}

interface CreditPackageListData {
  packages: AdminCreditPackage[];
  total: number;
  page: number;
  page_size: number;
}

export interface CreditPackageFilters {
  userID?: string;
  packageID?: string;
  productID?: string;
  status?: string;
  page: number;
  pageSize: number;
}

export function useCreditAdminPackages(filters: CreditPackageFilters) {
  return useQuery({
    queryKey: [...CREDIT_PACKAGES_QUERY_KEY, filters],
    queryFn: async () => {
      const response = await apiClient<CreditEnvelope<CreditPackageListData>>(
        "credit/packages",
        {
          params: {
            user_id: filters.userID || undefined,
            package_id: filters.packageID || undefined,
            product_id: filters.productID || undefined,
            status:
              filters.status && filters.status !== "all"
                ? filters.status
                : undefined,
            page: filters.page,
            page_size: filters.pageSize,
          },
        }
      );
      return response.data;
    },
  });
}

export function useCreditPackageRefund() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (packageID: string) =>
      apiClient<Record<string, unknown>>(
        `credit/packages/${encodeURIComponent(packageID)}/refund`,
        { method: "POST" }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CREDIT_PACKAGES_QUERY_KEY });
    },
  });
}
