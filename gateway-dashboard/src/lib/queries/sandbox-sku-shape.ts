export type SandboxTemplateClassStatus = "active" | "paused" | string;
export type SandboxResolutionMode = "legacy" | "shadow" | "sandbox_primary" | string;
export type SandboxSKURolloutState = "stable" | "rolling" | "blocked" | "degraded" | string;
export type SandboxPoolBindingRole = "primary" | "fallback" | "burst" | string;
export type SandboxBindingAdmissionState = "active" | "draining" | "paused" | "quarantined" | string;

export interface SandboxResolvedPool {
  id: string;
  name: string;
  base_image: string;
  desired_capacity: number;
  instance_type: string;
  system_disk_size?: number;
  status: "active" | "paused" | string;
  vpc_id: string;
  subnet_id: string;
  zone: string;
  template_class_id: string;
  sku_id: string;
  capacity_state?: string;
  max_capacity?: number;
  created_at: string;
}

export type SandboxResolvedPoolResponse = Omit<SandboxResolvedPool, "template_class_id" | "sku_id"> &
  Partial<Pick<SandboxResolvedPool, "template_class_id" | "sku_id">>;

export interface SandboxTemplateClass {
  id: string;
  name: string;
  description?: string;
  workload_type?: string;
  region?: string;
  default_pool_selection_policy?: string;
  resolution_mode: SandboxResolutionMode;
  status: SandboxTemplateClassStatus;
  import_generation?: number;
  divergence_message?: string;
  created_at: string;
  updated_at: string;
}

export interface SandboxSKU {
  id: string;
  name: string;
  description?: string;
  template_class_id: string;
  base_image: string;
  desired_image_id: string;
  stable_image_id?: string;
  instance_type: string;
  system_disk_size?: number;
  network_template_id?: string;
  security_group_rule_template_id?: string;
  autoscale_policy_id?: string;
  default_desired_capacity?: number;
  rollout_state: SandboxSKURolloutState;
  rollout_cursor_pool_id?: string;
  generation?: number;
  converged_pool_count?: number;
  total_pool_count?: number;
  pools_pending_rollout?: number;
  last_rollout_started_at?: string;
  last_rollout_error?: string;
  created_at: string;
  updated_at: string;
}

export interface SandboxTemplateSkuBinding {
  template_class_id: string;
  sku_id: string;
  priority: number;
  weight: number;
  admission_state?: SandboxBindingAdmissionState;
  region_affinity?: string;
  rollout_eligibility: boolean;
  created_at: string;
  updated_at: string;
}

export interface SandboxTemplatePoolBinding {
  template_class_id: string;
  pool_id: string;
  priority: number;
  weight: number;
  role: SandboxPoolBindingRole;
  admission_state: SandboxBindingAdmissionState;
  reason?: string;
  created_at: string;
  updated_at: string;
}

export interface SandboxTemplateClassResolveResponseRaw {
  template_class?: SandboxTemplateClass | null;
  bindings?: SandboxTemplatePoolBinding[] | null;
  pools?: SandboxResolvedPoolResponse[] | null;
}

export interface SandboxTemplateClassResolveResponse {
  template_class: SandboxTemplateClass | null;
  bindings: SandboxTemplatePoolBinding[];
  pools: SandboxResolvedPool[];
}

export interface SandboxTemplateClassWarningsInput {
  templateClass: SandboxTemplateClass | null;
  skuBindings: SandboxTemplateSkuBinding[];
  poolBindings: SandboxTemplatePoolBinding[];
  resolvedPools: SandboxResolvedPool[];
  skus: SandboxSKU[];
}

export function normalizeSandboxResolvedPool(pool: SandboxResolvedPoolResponse): SandboxResolvedPool {
  return {
    ...pool,
    template_class_id: pool.template_class_id?.trim() ?? "",
    sku_id: pool.sku_id?.trim() ?? "",
  };
}

export function normalizeSandboxTemplateClassResolve(
  response: SandboxTemplateClassResolveResponseRaw | null | undefined,
): SandboxTemplateClassResolveResponse {
  return {
    template_class: response?.template_class ?? null,
    bindings: response?.bindings ?? [],
    pools: (response?.pools ?? []).map(normalizeSandboxResolvedPool),
  };
}

export function deriveSandboxTemplateClassWarnings(input: SandboxTemplateClassWarningsInput): string[] {
  const warnings: string[] = [];
  const templateClassID = input.templateClass?.id ?? "当前 Template Class";
  const resolvedPoolIDs = new Set(input.resolvedPools.map((pool) => pool.id));
  const skuByID = new Map(input.skus.map((sku) => [sku.id, sku]));

  if (input.templateClass && input.templateClass.status !== "active") {
    warnings.push(`${templateClassID} 当前状态为 ${input.templateClass.status}，可能不会接收新的分配流量。`);
  }

  if (input.resolvedPools.length === 0) {
    warnings.push(`${templateClassID} 当前没有可解析的 pool，Bot 创建可能失败。`);
  }

  for (const binding of input.poolBindings) {
    if (binding.admission_state !== "active") {
      warnings.push(`Pool binding ${binding.pool_id} admission_state=${binding.admission_state}，不会作为正常 active 流量候选。`);
    }
    if (!resolvedPoolIDs.has(binding.pool_id)) {
      warnings.push(`Pool binding ${binding.pool_id} 未出现在 resolve 结果中，可能是 pool 不存在、暂停或容量状态不可用。`);
    }
  }

  for (const binding of input.skuBindings) {
    const sku = skuByID.get(binding.sku_id);
    if (!sku) {
      warnings.push(`SKU binding ${binding.sku_id} 找不到对应 SKU，分配路径可能失效。`);
      continue;
    }
    if (sku.rollout_state === "blocked" || sku.rollout_state === "degraded") {
      warnings.push(`SKU ${sku.id} rollout_state=${sku.rollout_state}，需要先处理 rollout 风险。`);
    }
    if (binding.admission_state && binding.admission_state !== "active") {
      warnings.push(`SKU binding ${binding.sku_id} admission_state=${binding.admission_state}，不会作为正常 active 流量候选。`);
    }
  }

  return Array.from(new Set(warnings));
}
