const MODEL_ENTRY_ACCOUNT_MENU_BUNDLE_IDS = new Set([
  "bundle_launch_ai_01",
  "bundle_cruise_ai_01",
]);

/**
 * AI 积分套餐把模型配置入口从 Agent 主导航迁移到侧栏账号菜单。
 * 套餐 ID 需与 AgentContext.resolveBotQuotaPerAgent 的套餐映射保持同步。
 */
export const shouldMoveModelEntryToAccountMenu = (bundleId?: string | null): boolean =>
  MODEL_ENTRY_ACCOUNT_MENU_BUNDLE_IDS.has((bundleId ?? "").trim());
