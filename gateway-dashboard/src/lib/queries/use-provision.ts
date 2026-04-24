import { useMutation } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

interface ProvisionRequest {
  user_id: string;
  phone?: string;
  nickname?: string;
  plan_id: string;
  period_start?: string;
  assign_api_key?: boolean;
}

// 后端实际返回的结构
interface ProvisionBackendResponse {
  user: {
    id: string;
    user_id: string;
    phone: string;
    nickname: string;
    status: string;
  };
  subscription: {
    id: string;
    token_balance: number;
    plan_id: string;
    status: string;
    period_start: string;
    period_end: string;
    plan: {
      id: string;
      name: string;
    };
  };
  api_key: string | null;
  api_key_assigned: boolean;
}

// 前端展示用的结构
export interface ProvisionResult {
  gateway_user_id: string;
  user_id: string;
  api_key: string | null;
  api_key_assigned: boolean;
  plan_id: string;
  plan_name: string;
  token_balance: number;
  period_start: string;
  period_end: string;
}

export function useProvision() {
  return useMutation({
    mutationFn: async (data: ProvisionRequest): Promise<ProvisionResult> => {
      const res = await apiClient<ProvisionBackendResponse>("ai-gateway/provision", {
        method: "POST",
        body: data,
      });
      // 适配后端响应 → 前端展示格式
      return {
        gateway_user_id: res.user.id,
        user_id: res.user.user_id ?? res.user.id,
        api_key: res.api_key,
        api_key_assigned: res.api_key_assigned,
        plan_id: res.subscription.plan_id,
        plan_name: res.subscription.plan?.name ?? "",
        token_balance: res.subscription.token_balance,
        period_start: res.subscription.period_start,
        period_end: res.subscription.period_end,
      };
    },
  });
}
