import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { ensureItems } from "@/lib/page-null-guards";
import {
  normalizeSandboxTemplateClassResolve,
  type SandboxSKU,
  type SandboxTemplateClass,
  type SandboxTemplateClassResolveResponseRaw,
  type SandboxTemplatePoolBinding,
  type SandboxTemplateSkuBinding,
} from "@/lib/queries/sandbox-sku-shape";

export {
  deriveSandboxTemplateClassWarnings,
  normalizeSandboxTemplateClassResolve,
  type SandboxBindingAdmissionState,
  type SandboxPoolBindingRole,
  type SandboxResolutionMode,
  type SandboxResolvedPool,
  type SandboxResolvedPoolResponse,
  type SandboxSKU,
  type SandboxSKURolloutState,
  type SandboxTemplateClass,
  type SandboxTemplateClassResolveResponse,
  type SandboxTemplateClassResolveResponseRaw,
  type SandboxTemplateClassStatus,
  type SandboxTemplateClassWarningsInput,
  type SandboxTemplatePoolBinding,
  type SandboxTemplateSkuBinding,
} from "@/lib/queries/sandbox-sku-shape";

export function useSandboxTemplateClasses() {
  return useQuery({
    queryKey: ["sandbox", "template-classes"],
    queryFn: async () => ensureItems(await apiClient<SandboxTemplateClass[] | null>("sandbox/template-classes")),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useSandboxSKUs() {
  return useQuery({
    queryKey: ["sandbox", "skus"],
    queryFn: async () => ensureItems(await apiClient<SandboxSKU[] | null>("sandbox/skus")),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useSandboxTemplateClassSKUBindings(templateClassID: string) {
  return useQuery({
    queryKey: ["sandbox", "template-classes", templateClassID, "skus"],
    queryFn: async () => ensureItems(await apiClient<SandboxTemplateSkuBinding[] | null>(`sandbox/template-classes/${encodeURIComponent(templateClassID)}/skus`)),
    enabled: templateClassID.length > 0,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useSandboxTemplateClassPoolBindings(templateClassID: string) {
  return useQuery({
    queryKey: ["sandbox", "template-classes", templateClassID, "bindings"],
    queryFn: async () => ensureItems(await apiClient<SandboxTemplatePoolBinding[] | null>(`sandbox/template-classes/${encodeURIComponent(templateClassID)}/bindings`)),
    enabled: templateClassID.length > 0,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useSandboxTemplateClassResolve(templateClassID: string) {
  return useQuery({
    queryKey: ["sandbox", "template-classes", templateClassID, "resolve"],
    queryFn: async () => normalizeSandboxTemplateClassResolve(
      await apiClient<SandboxTemplateClassResolveResponseRaw | null>(`sandbox/template-classes/${encodeURIComponent(templateClassID)}/resolve`),
    ),
    enabled: templateClassID.length > 0,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}
