import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { migrationRequestBody, quotaResetRequestBody } from "@/lib/queries/gateway-operation-policy";

interface CtlEnvelope<T> {
  code: string;
  message: string;
  data: T;
}

export type GatewayOperation = "migrate" | "reset_quota";

export interface GatewayMigrationResult {
  user_id: string;
  instance_id: string;
  previous_gateway: string;
  target_gateway: string;
  dry_run: boolean;
  migrated: boolean;
  already_migrated?: boolean;
  key_id?: string;
  key_prefix?: string;
  legacy_key_revoked?: boolean;
}

export interface GatewayQuotaResetResult {
  user_id: string;
  gateway: "llm_gateway";
  set_id: string;
  plan_id: string;
  upstream_plan_id: number;
  subscription_id: string;
  amount_used_before: number;
  amount_used_after: number;
  next_reset_time: number;
  end_time: number;
  dry_run: boolean;
  status: "ready" | "already_reset" | "reset";
  schedule_unchanged: boolean;
}

export function useMigrateCtlBot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ instanceID, userID, dryRun }: { instanceID: string; userID: string; dryRun: boolean }) =>
      apiClient<CtlEnvelope<GatewayMigrationResult>>(`ctl/instances/${encodeURIComponent(instanceID)}/gateway/migrate`, {
        method: "POST",
        body: migrationRequestBody(userID, dryRun),
      }).then((response) => response.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ctl-bots"] }),
  });
}

export function useResetCtlUserQuota() {
  return useMutation({
    mutationFn: ({ userID, dryRun }: { userID: string; dryRun: boolean }) =>
      apiClient<CtlEnvelope<GatewayQuotaResetResult>>(`ctl/users/${encodeURIComponent(userID)}/gateway/quota/reset`, {
        method: "POST",
        body: quotaResetRequestBody(dryRun),
      }).then((response) => response.data),
  });
}
