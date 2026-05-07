type OpenClawCreateAvailabilityStatus = "running" | "paused" | "draft" | "provisioning" | "failed" | "deleting";

export interface OpenClawCreateAvailabilityBot {
  status: OpenClawCreateAvailabilityStatus;
}

export const getOpenClawCreateLimitMessage = (
  bots: readonly OpenClawCreateAvailabilityBot[],
  maxBots: number,
): string | null => {
  if (bots.length < maxBots) return null;

  if (bots.some((bot) => bot.status === "provisioning")) {
    return "已有智能体正在创建中，请稍后刷新页面查看结果。";
  }

  if (bots.some((bot) => bot.status === "deleting")) {
    return "已有智能体正在删除中，请稍后刷新页面后再创建。";
  }

  return `当前套餐最多可创建 ${maxBots} 个智能体，请升级套餐或删除现有智能体后重试。`;
};
