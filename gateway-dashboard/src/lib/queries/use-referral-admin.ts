import { useMutation, useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

interface ReferralEnvelope<T> {
  success: boolean;
  data: T;
}

export interface ReferralAttribution {
  attribution_id: string;
  campaign_id: string;
  invitee_user_id: string;
  inviter_user_id: string;
  referral_code: string;
  registration_event_id: string;
  registered_at: string;
  created_at: string;
}

export interface ReferralAttributionReward {
  reward_id: string;
  beneficiary_user_id: string;
  reward_side: "inviter" | "invitee" | string;
  credit_amount: number;
  status: string;
  subscription_id?: string;
  subscription_name?: string;
}

export interface ReferralAttributionResetPreview {
  attribution: ReferralAttribution;
  rewards: ReferralAttributionReward[];
  resettable: boolean;
  block_reason?: string;
}

export interface ReferralAttributionResetResult {
  operation_id: string;
  idempotency_key: string;
  invitee_user_id: string;
  attribution_id: string;
  rewards_removed: number;
  subscriptions_revoked: number;
  completed_at: string;
}

export interface ReferralAttributionResetInput {
  inviteeUserID: string;
  expectedAttributionID: string;
  idempotencyKey: string;
  operator: string;
  reason: string;
}

export function useReferralAttribution(
  inviteeUserID: string,
  attributionID?: string
) {
  return useQuery({
    queryKey: ["referral-admin", "attribution", inviteeUserID, attributionID],
    enabled: inviteeUserID.length > 0,
    retry: false,
    queryFn: async () => {
      const response = await apiClient<
        ReferralEnvelope<ReferralAttributionResetPreview>
      >(`referral/attributions/${encodeURIComponent(inviteeUserID)}`, {
        params: {
          attribution_id: attributionID || undefined,
        },
      });
      return response.data;
    },
  });
}

export function useResetReferralAttribution() {
  return useMutation({
    mutationFn: async (input: ReferralAttributionResetInput) => {
      const response = await apiClient<
        ReferralEnvelope<ReferralAttributionResetResult>
      >(
        `referral/attributions/${encodeURIComponent(input.inviteeUserID)}/reset`,
        {
          method: "POST",
          body: {
            expected_attribution_id: input.expectedAttributionID,
            idempotency_key: input.idempotencyKey,
            operator: input.operator,
            reason: input.reason,
          },
        }
      );
      return response.data;
    },
  });
}
