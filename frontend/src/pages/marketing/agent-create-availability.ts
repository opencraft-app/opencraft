type OpenClawCreateAvailabilityStatus = "running" | "paused" | "draft" | "provisioning" | "failed" | "deleting";

export interface OpenClawCreateAvailabilityBot {
  status: OpenClawCreateAvailabilityStatus;
}

export interface OpenClawCreateStatusBot extends OpenClawCreateAvailabilityBot {
  id: string;
}

export interface OpenClawCreatePermissions {
  canCreateInitialAgent: boolean;
  canCreateAdditionalBot: boolean;
}

export const resolveOpenClawCreatePermissions = (
  multiBotEnabled: boolean,
  createLimitMessage: string | null,
): OpenClawCreatePermissions => {
  const canCreateInitialAgent = createLimitMessage === null;
  return {
    canCreateInitialAgent,
    canCreateAdditionalBot: multiBotEnabled && canCreateInitialAgent,
  };
};

export const findCompletedCreatingBot = <T extends OpenClawCreateStatusBot>(
  bots: readonly T[],
  requestedBotId: string,
): T | null => {
  if (!requestedBotId) return null;
  return bots.find((bot) => (
    bot.id === requestedBotId
    && bot.status !== "provisioning"
    && bot.status !== "deleting"
  )) ?? null;
};

export const getOpenClawCreateLimitMessage = (
  bots: readonly OpenClawCreateAvailabilityBot[],
  maxBots: number,
): string | null => {
  if (maxBots <= 0) return null;
  if (bots.length < maxBots) return null;

  if (bots.some((bot) => bot.status === "provisioning")) {
    return "已有 Bot 正在创建中，请稍后刷新页面查看结果。";
  }

  if (bots.some((bot) => bot.status === "deleting")) {
    return "已有 Bot 正在删除中，请稍后刷新页面后再创建。";
  }

  if (maxBots === 5) {
    return "当前套餐最多可创建 5 个 Bot（含主 Bot）。可升级至巡游套餐，或删除已有 Bot 后再创建。";
  }

  return `当前套餐最多可创建 ${maxBots} 个 Bot（含主 Bot），请升级套餐或删除已有 Bot 后再创建。`;
};
