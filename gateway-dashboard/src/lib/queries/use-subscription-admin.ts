import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

export interface SubscriptionAdminRecord {
  id: string;
  externalUserId: string;
  code: string;
  status: string;
  aiGatewayPlanId?: string;
  aiGatewaySubscriptionId?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  sourceOrderId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionAdminEvent {
  id: string;
  subscriptionId: string;
  eventType: string;
  code: string;
  status: string;
  sourceOrderId?: string;
  createdAt: string;
}

export interface SubscriptionAdminPlan {
  code: string;
  description: string;
  maxBotCount: number;
  createdAt: string;
  updatedAt: string;
}

interface AdminListResponse<T> {
  items: T[];
  total: number;
}

export function useSubscriptionAdminPlans() {
  return useQuery({
    queryKey: ["subscription", "plans"],
    queryFn: () =>
      apiClient<AdminListResponse<SubscriptionAdminPlan>>("subscription/plans"),
  });
}

export function useSubscriptionAdminSubscriptions(search?: string, status?: string, code?: string, limit: number = 100) {
  return useQuery({
    queryKey: ["subscription", "subscriptions", search, status, code, limit],
    queryFn: () =>
      apiClient<AdminListResponse<SubscriptionAdminRecord>>("subscription/subscriptions", {
        params: { search, status, code, limit },
      }),
  });
}

export function useSubscriptionAdminEvents(externalUserId?: string, limit: number = 100) {
  return useQuery({
    queryKey: ["subscription", "subscriptions", externalUserId, "events", limit],
    queryFn: () =>
      apiClient<AdminListResponse<SubscriptionAdminEvent>>(
        `subscription/subscriptions/${encodeURIComponent(externalUserId ?? "")}/events`,
        { params: { limit } }
      ),
    enabled: !!externalUserId,
  });
}

export function useSubscriptionAdminUpsertPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      code,
      description,
      maxBotCount,
    }: {
      code: string;
      description: string;
      maxBotCount: number;
    }) =>
      apiClient<SubscriptionAdminPlan>(
        `subscription/plans/${encodeURIComponent(code)}`,
        {
          method: "PUT",
          body: { description, maxBotCount },
        }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subscription", "plans"] });
      queryClient.invalidateQueries({ queryKey: ["subscription", "subscriptions"] });
    },
  });
}

export function useSubscriptionAdminDeletePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) =>
      apiClient<void>(`subscription/plans/${encodeURIComponent(code)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subscription", "plans"] });
      queryClient.invalidateQueries({ queryKey: ["subscription", "subscriptions"] });
    },
  });
}

export function useSubscriptionAdminSet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ externalUserId, code }: { externalUserId: string; code: string }) =>
      apiClient<SubscriptionAdminRecord>(
        `subscription/subscriptions/${encodeURIComponent(externalUserId)}`,
        {
          method: "PUT",
          body: { code },
        }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subscription", "subscriptions"] });
    },
  });
}

export function useSubscriptionAdminResync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (externalUserId: string) =>
      apiClient<SubscriptionAdminRecord>(
        `subscription/subscriptions/${encodeURIComponent(externalUserId)}/resync`,
        {
          method: "POST",
        }
      ),
    onSuccess: (_, externalUserId) => {
      queryClient.invalidateQueries({ queryKey: ["subscription", "subscriptions"] });
      queryClient.invalidateQueries({ queryKey: ["subscription", "subscriptions", externalUserId, "events"] });
    },
  });
}

export function useSubscriptionAdminCancel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (externalUserId: string) =>
      apiClient<SubscriptionAdminRecord>(
        `subscription/subscriptions/${encodeURIComponent(externalUserId)}`,
        {
          method: "DELETE",
        }
      ),
    onSuccess: (_, externalUserId) => {
      queryClient.invalidateQueries({ queryKey: ["subscription", "subscriptions"] });
      queryClient.invalidateQueries({ queryKey: ["subscription", "subscriptions", externalUserId, "events"] });
    },
  });
}
