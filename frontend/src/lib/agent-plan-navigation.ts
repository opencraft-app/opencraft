import type { Pass } from "@/domain/types";

type PassWithBundleType = Pick<Pass, "bundle_id"> & {
  bundle_type?: unknown;
};

/**
 * AI 积分套餐把模型配置入口从 Agent 主导航迁移到侧栏账号菜单。
 * bundle_type 由 CTL 的 /v1/passes 响应提供；缺失或未知值保守地保留主导航入口。
 */
export const shouldMoveModelEntryToAccountMenu = (pass?: PassWithBundleType | null): boolean =>
  pass?.bundle_type === "ai";
