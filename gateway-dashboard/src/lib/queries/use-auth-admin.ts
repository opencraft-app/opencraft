import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

export interface AuthAdminUser {
  id: string;
  name: string;
  email: string;
  phone: string;
  authMethods: string[];
  qqOpenId: string;
  inviteRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthAdminSMSChallenge {
  phone: string;
  code: string;
  expiresAt: string;
  cooldownUntil: string;
  remainingRetries: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuthAdminInvite {
  code: string;
  state: string;
  message: string;
  usedByUserId: string;
  usedVia: string;
  usedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthImpersonationSession {
  loginUrl: string;
  expiresAt: string;
  userId: string;
  impersonated: boolean;
}

interface AdminListResponse<T> {
  items: T[];
  total: number;
}

export function useAuthAdminUsers(search?: string, limit: number = 100) {
  return useQuery({
    queryKey: ["auth", "users", search, limit],
    queryFn: () =>
      apiClient<AdminListResponse<AuthAdminUser>>("auth/users", {
        params: { search, limit },
      }),
  });
}

export function useDeleteAuthAdminUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userID: string) =>
      apiClient(`auth/users/${encodeURIComponent(userID)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth", "users"] });
    },
  });
}

export function useCreateAuthImpersonationSession() {
  return useMutation({
    mutationFn: ({
      userID,
      returnTo,
      reason,
    }: {
      userID: string;
      returnTo: string;
      reason: string;
    }) =>
      apiClient<AuthImpersonationSession>(
        `auth/users/${encodeURIComponent(userID)}/impersonation-sessions`,
        {
          method: "POST",
          body: { returnTo, reason },
        }
      ),
  });
}

export function useAuthAdminSMSChallenges(search?: string, limit: number = 100) {
  return useQuery({
    queryKey: ["auth", "sms-challenges", search, limit],
    queryFn: () =>
      apiClient<AdminListResponse<AuthAdminSMSChallenge>>(
        "auth/sms-challenges",
        {
          params: { search, limit },
        }
      ),
  });
}

export function useDeleteAuthAdminSMSChallenge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (phone: string) =>
      apiClient(`auth/sms-challenges/${encodeURIComponent(phone)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth", "sms-challenges"] });
    },
  });
}

export function useAuthAdminInvites(search?: string, state?: string, limit: number = 100) {
  return useQuery({
    queryKey: ["auth", "invites", search, state, limit],
    queryFn: () =>
      apiClient<AdminListResponse<AuthAdminInvite>>("auth/invites", {
        params: { search, state, limit },
      }),
  });
}

export function useCreateAuthAdminInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ code, message }: { code?: string; message?: string }) =>
      apiClient<AuthAdminInvite>("auth/invites", {
        method: "POST",
        body: { code, message },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth", "invites"] });
    },
  });
}

export function useDisableAuthAdminInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) =>
      apiClient(`auth/invites/${encodeURIComponent(code)}/disable`, {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth", "invites"] });
    },
  });
}
