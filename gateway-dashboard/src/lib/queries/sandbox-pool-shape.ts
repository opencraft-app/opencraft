export type SandboxPoolStatus = "active" | "paused";
export type SandboxPoolCapacityState =
  | "active"
  | "draining"
  | "paused"
  | "quarantined"
  | "retiring"
  | "";
export type SandboxInstanceState =
  | "CREATING"
  | "CLEAN"
  | "ALLOCATED"
  | "DRY"
  | "RESETTING"
  | "REINSTALLING"
  | "DELETING"
  | "FAILED"
  | "DELETED";

export interface SandboxPool {
  id: string;
  name: string;
  description?: string;
  base_image: string;
  desired_capacity: number;
  instance_type: string;
  system_disk_size: number;
  status: SandboxPoolStatus;
  pause_reason?: string;
  consecutive_refill_failures?: number;
  last_refill_error_code?: string;
  last_refill_error?: string;
  vpc_id: string;
  subnet_id: string;
  zone: string;
  security_groups?: string[];
  template_class_id: string;
  sku_id: string;
  capacity_state?: SandboxPoolCapacityState;
  max_capacity?: number;
  capacity_bundle_id?: string;
  autoscale_generation?: number;
  last_autoscale_action?: string;
  last_health_transition_at?: string;
  created_at: string;
}

export type SandboxPoolResponse = Omit<SandboxPool, "template_class_id" | "sku_id" | "system_disk_size"> &
  Partial<Pick<SandboxPool, "template_class_id" | "sku_id" | "system_disk_size">>;

export interface SandboxPoolInstance {
  id: string;
  pool_id: string;
  state: SandboxInstanceState;
  cloud_id?: string;
  address?: string;
  created_at: string;
  updated_at: string;
}

export function normalizeSandboxPool(pool: SandboxPoolResponse): SandboxPool {
  return {
    ...pool,
    template_class_id: pool.template_class_id?.trim() ?? "",
    sku_id: pool.sku_id?.trim() ?? "",
    system_disk_size: pool.system_disk_size ?? 0,
  };
}

export function normalizeSandboxPools(pools: SandboxPoolResponse[] | null | undefined): SandboxPool[] {
  return (pools ?? []).map(normalizeSandboxPool);
}

export function isLegacySandboxPool(pool: Pick<SandboxPool, "template_class_id" | "sku_id">): boolean {
  return pool.template_class_id.trim() === "" && pool.sku_id.trim() === "";
}
