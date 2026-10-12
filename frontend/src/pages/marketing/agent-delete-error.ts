export const getAgentDeleteErrorMessage = (
  error: unknown,
  embedded: boolean,
  t: (message: string) => string,
): string => {
  const code = error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
  const message = error instanceof Error ? error.message : "";

  if (code === "CHANNEL_OCCUPIED" && message.includes("disconnect weixin before deleting bot")) {
    return t("请先断开该 Bot 的微信，再删除 Bot。");
  }
  if (code === "INSTANCE_BOTS_REMAIN") {
    return t("请先删除其他 Bot，再删除整个 Agent。");
  }
  return embedded ? t("删除失败，请稍后重试。")
    : error instanceof Error ? error.message : t("删除失败，请稍后重试。");
};
