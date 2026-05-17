import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { ensureItems } from "@/lib/page-null-guards";
import {
  normalizeSandboxPools,
  type SandboxPool,
  type SandboxPoolInstance,
  type SandboxPoolResponse,
  type SandboxPoolStatus,
} from "@/lib/queries/sandbox-pool-shape";

export {
  isLegacySandboxPool,
  normalizeSandboxPool,
  normalizeSandboxPools,
  type SandboxInstanceState,
  type SandboxPool,
  type SandboxPoolCapacityState,
  type SandboxPoolInstance,
  type SandboxPoolResponse,
  type SandboxPoolStatus,
} from "@/lib/queries/sandbox-pool-shape";

export interface SandboxPoolInput {
  name: string;
  description?: string;
  base_image: string;
  desired_capacity: number;
  instance_type?: string;
  status?: SandboxPoolStatus;
  pause_reason?: string;
  vpc_id: string;
  subnet_id: string;
  zone: string;
  security_groups: string[];
}

export interface SandboxPoolUpdateInput extends SandboxPoolInput {
  mark_clean_as_dry?: boolean;
}

export function useSandboxPools() {
  return useQuery({
    queryKey: ["sandbox-pools"],
    queryFn: async () => normalizeSandboxPools(await apiClient<SandboxPoolResponse[] | null>("sandbox/pools")),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useSandboxPoolInstances(poolID: string | null, enabled: boolean = true) {
  return useQuery({
    queryKey: ["sandbox-pools", poolID, "instances"],
    queryFn: async () =>
      ensureItems(await apiClient<SandboxPoolInstance[] | null>(`sandbox/pools/${poolID}/instances`)),
    enabled: enabled && !!poolID,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useSandboxPoolInstanceSummaries(poolIDs: string[]) {
  return useQueries({
    queries: poolIDs.map((poolID) => ({
      queryKey: ["sandbox-pools", poolID, "instances"],
      queryFn: async () =>
        ensureItems(await apiClient<SandboxPoolInstance[] | null>(`sandbox/pools/${poolID}/instances`)),
      staleTime: 10_000,
      refetchInterval: 30_000,
    })),
  });
}

export function useCreateSandboxPool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SandboxPoolInput) =>
      apiClient<SandboxPool>("sandbox/pools", {
        method: "POST",
        body: data,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sandbox-pools"] });
    },
  });
}

export function useUpdateSandboxPool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: SandboxPoolUpdateInput & { id: string }) =>
      apiClient<SandboxPool>(`sandbox/pools/${id}`, {
        method: "PATCH",
        body: data,
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["sandbox-pools"] });
      queryClient.invalidateQueries({ queryKey: ["sandbox-pools", variables.id, "instances"] });
    },
  });
}
