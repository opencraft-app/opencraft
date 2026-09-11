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

type Translate = (message: string) => string;

const identityTranslate: Translate = (message) => message;

const getCreateLimitMessages = (t: Translate) => ({
  provisioning: t("已有 Bot 正在创建中，请稍后刷新页面查看结果。"),
  deleting: t("已有 Bot 正在删除中，请稍后刷新页面后再创建。"),
  launch: t("当前套餐最多可创建 5 个 Bot（含主 Bot）。可升级至巡游套餐，或删除已有 Bot 后再创建。"),
  generic: t("当前套餐最多可创建 {{maxBots}} 个 Bot（含主 Bot），请升级套餐或删除已有 Bot 后再创建。"),
});

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
  translate: Translate = identityTranslate,
): string | null => {
  if (maxBots <= 0) return null;
  if (bots.length < maxBots) return null;

  const messages = getCreateLimitMessages(translate);

  if (bots.some((bot) => bot.status === "provisioning")) {
    return messages.provisioning;
  }

  if (bots.some((bot) => bot.status === "deleting")) {
    return messages.deleting;
  }

  if (maxBots === 5) {
    return messages.launch;
  }

  return messages.generic.replace(/\{\{\s*maxBots\s*\}\}/g, String(maxBots));
};
