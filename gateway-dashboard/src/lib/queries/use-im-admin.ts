import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiClient } from "@/lib/api-client";

export interface ImAdminSummary {
  humansReady: number;
  humansPending: number;
  bots: { ready: number; provisioning: number; error: number; deleted: number };
  groupsActive: number;
  groupsDismissed: number;
  restrictedIdentities: number;
  estimatedTencentAccounts: number;
}

export interface ImAdminIdentity {
  userId: string;
  kind: "human" | "bot";
  state: string;
  displayName: string;
  accountId?: string;
  lightvelaUserId?: string;
  botAgentId?: string;
  instanceId?: string;
  botId?: string;
  restricted: boolean;
  restrictedAt?: string;
  createdAt?: string;
}

export interface ImAdminGroup {
  id: string;
  tencentGroupId: string;
  name: string;
  ownerAccountId: string;
  ownerLightvelaUserId?: string;
  createdByUserId: string;
  replyMode: "mention" | "mention_context" | "all";
  state: "provisioning" | "active" | "dismissed";
  dismissedBy?: "owner" | "admin" | "tencent" | null;
  dismissReason?: string | null;
  memberCount: number;
  createdAt?: string;
}

export interface ImAdminGroupMember {
  userId: string;
  kind: "human" | "bot";
  role: "owner" | "admin" | "member";
  state: string;
  displayName?: string;
}

export interface ImAdminTencentCheck {
  checked: number;
  imported: number;
  mismatches: Array<{ userId: string; kind: string; state: string; expected: "present" | "absent"; tencent: "imported" | "missing" }>;
}

interface Page<T> {
  items: T[];
  total: number;
}

export const IM_ADMIN_PAGE_SIZE = 50;

/** collaboration answers `{error: {code, message}}`; other modules answer `{error: "..."}`. */
export function imAdminErrorMessage(error: unknown): string {
  if (error instanceof ApiError && typeof error.data === "object" && error.data !== null) {
    const body = (error.data as { error?: unknown }).error;
    if (typeof body === "string") return body;
    if (typeof body === "object" && body !== null && "message" in body) return String((body as { message: unknown }).message);
  }
  return error instanceof Error ? error.message : String(error);
}

export function useImAdminSummary() {
  return useQuery({
    queryKey: ["im-admin", "summary"],
    retry: false,
    queryFn: () => apiClient<ImAdminSummary>("collaboration/summary"),
  });
}

export function useImAdminIdentities(query: string, kind: "" | "human" | "bot", page: number) {
  return useQuery({
    queryKey: ["im-admin", "identities", query, kind, page],
    retry: false,
    queryFn: () =>
      apiClient<Page<ImAdminIdentity>>("collaboration/identities", {
        params: { q: query || undefined, kind: kind || undefined, limit: IM_ADMIN_PAGE_SIZE, offset: page * IM_ADMIN_PAGE_SIZE },
      }),
  });
}

export function useImAdminGroups(query: string, state: "" | "active" | "dismissed", page: number) {
  return useQuery({
    queryKey: ["im-admin", "groups", query, state, page],
    retry: false,
    queryFn: () =>
      apiClient<Page<ImAdminGroup>>("collaboration/groups", {
        params: { q: query || undefined, state: state || undefined, limit: IM_ADMIN_PAGE_SIZE, offset: page * IM_ADMIN_PAGE_SIZE },
      }),
  });
}

export function useImAdminGroup(groupId: string | null) {
  return useQuery({
    queryKey: ["im-admin", "group", groupId],
    enabled: !!groupId,
    retry: false,
    queryFn: () => apiClient<{ group: ImAdminGroup; members: ImAdminGroupMember[] }>(`collaboration/groups/${encodeURIComponent(groupId!)}`),
  });
}

function useImAdminMutation<TInput, TResult>(run: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["im-admin"] }),
  });
}

export function useRestrictImIdentity() {
  return useImAdminMutation(({ userId, restricted }: { userId: string; restricted: boolean }) =>
    apiClient<ImAdminIdentity>(`collaboration/identities/${encodeURIComponent(userId)}/${restricted ? "restrict" : "release"}`, { method: "POST" }));
}

export const IM_DISMISS_REASON_MAX = 200;

export function useDismissImGroup() {
  return useImAdminMutation(({ groupId, reason }: { groupId: string; reason: string }) =>
    apiClient<void>(`collaboration/groups/${encodeURIComponent(groupId)}/dismiss`, { method: "POST", body: { reason } }));
}

export function useDisableImBot() {
  return useImAdminMutation(({ accountId, botAgentId }: { accountId: string; botAgentId: string }) =>
    apiClient<void>(`collaboration/accounts/${encodeURIComponent(accountId)}/bots/${encodeURIComponent(botAgentId)}/disable`, { method: "POST" }));
}

export function useImTencentCheck() {
  return useMutation({
    mutationFn: () => apiClient<ImAdminTencentCheck>("collaboration/tencent-check", { method: "POST" }),
  });
}
