import { z } from "zod";

import type { SandboxPool, SandboxPoolStatus } from "./sandbox-pool-shape.ts";
import type { SandboxSKU } from "./sandbox-sku-shape.ts";

export const poolFormSchema = z.object({
  name: z.string().min(1, "Pool 名称不能为空").max(64, "最多 64 个字符"),
  description: z.string().optional(),
  base_image: z.string().min(1, "Base image 不能为空"),
  desired_capacity: z.number().int().min(0, "不能为负数"),
  instance_type: z.string().min(1, "Instance Type 不能为空"),
  system_disk_size: z.number().int().min(1, "系统盘必须大于 0 GB"),
  sku_id: z.string().min(1, "请选择 SKU"),
  status: z.enum(["active", "paused"]),
  pause_reason: z.string().optional(),
  vpc_id: z.string().min(1, "VPC ID 不能为空"),
  subnet_id: z.string().min(1, "Subnet ID 不能为空"),
  zone: z.string().min(1, "Zone 不能为空"),
  security_groups_text: z.string().optional(),
  mark_clean_as_dry: z.boolean(),
});

export type PoolFormValues = z.infer<typeof poolFormSchema>;

export interface PoolCreatePayload {
  name: string;
  description: string;
  base_image: string;
  desired_capacity: number;
  instance_type: string;
  sku_id: string;
  status: SandboxPoolStatus;
  pause_reason: string;
  vpc_id: string;
  subnet_id: string;
  zone: string;
  security_groups: string[];
}

export interface PoolUpdatePayload extends PoolCreatePayload {
  system_disk_size: number;
}

export function defaultPoolFormValues(): PoolFormValues {
  return {
    name: "",
    description: "",
    base_image: "",
    desired_capacity: 0,
    instance_type: "",
    system_disk_size: 50,
    sku_id: "",
    status: "paused",
    pause_reason: "awaiting operator activation",
    vpc_id: "",
    subnet_id: "",
    zone: "",
    security_groups_text: "",
    mark_clean_as_dry: false,
  };
}

export function poolToFormValues(pool: SandboxPool): PoolFormValues {
  return {
    name: pool.name,
    description: pool.description ?? "",
    base_image: pool.base_image,
    desired_capacity: pool.desired_capacity,
    instance_type: pool.instance_type ?? "",
    system_disk_size: pool.system_disk_size || 50,
    sku_id: pool.sku_id ?? "",
    status: pool.status,
    pause_reason: pool.pause_reason ?? "",
    vpc_id: pool.vpc_id,
    subnet_id: pool.subnet_id,
    zone: pool.zone,
    security_groups_text: (pool.security_groups ?? []).join(", "),
    mark_clean_as_dry: false,
  };
}

function parseSecurityGroups(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function poolPayload(values: PoolFormValues): PoolCreatePayload {
  return {
    name: values.name.trim(),
    description: values.description?.trim() || "",
    base_image: values.base_image.trim(),
    desired_capacity: values.desired_capacity,
    instance_type: values.instance_type.trim(),
    sku_id: values.sku_id.trim(),
    status: values.status,
    pause_reason: values.pause_reason?.trim() || "",
    vpc_id: values.vpc_id.trim(),
    subnet_id: values.subnet_id.trim(),
    zone: values.zone.trim(),
    security_groups: parseSecurityGroups(values.security_groups_text),
  };
}

export function poolCreatePayload(values: PoolFormValues): PoolCreatePayload {
  return {
    ...poolPayload(values),
    desired_capacity: 0,
    status: "paused",
    pause_reason: "awaiting operator activation",
  };
}

export function poolUpdatePayload(values: PoolFormValues): PoolUpdatePayload {
  return {
    ...poolPayload(values),
    system_disk_size: values.system_disk_size,
  };
}

export function deriveTemplateClassID(skus: SandboxSKU[], skuID: string): string {
  return skus.find((sku) => sku.id === skuID)?.template_class_id ?? "";
}

export function deriveSystemDiskSize(skus: SandboxSKU[], skuID: string): number {
  return skus.find((sku) => sku.id === skuID)?.system_disk_size || 50;
}

export function canSelectPoolSKU(pool: SandboxPool | null): boolean {
  return pool === null || (!pool.sku_id?.trim() && !pool.template_class_id?.trim());
}
