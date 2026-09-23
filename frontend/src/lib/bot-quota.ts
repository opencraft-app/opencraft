import type { Pass } from "@/domain/types";

/** 每台 Hermes / Agent 实例内的 Bot 上限；不是 bundle.agent_quota（实例数量）。
 * 套餐权益调整时在此统一维护，供创建门禁与订阅页展示共用。 */
export const BOT_QUOTA_BY_BUNDLE: Readonly<Partial<Record<string, number>>> = {
  bundle_launch_01: 5,
  bundle_launch_ai_01: 5,
  bundle_cruise_01: 10,
  bundle_cruise_ai_01: 10,
};

export const resolveBotQuotaPerAgent = (pass: Pick<Pass, "bundle_id"> | null): number =>
  (pass ? BOT_QUOTA_BY_BUNDLE[pass.bundle_id] : undefined) ?? 1;
