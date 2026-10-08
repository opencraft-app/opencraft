import type { OpenClawBot } from "@/contexts/agent-context";
import { t } from "@/i18n/t";

export const getBotStatusColor = (status: OpenClawBot["status"], restarting = false) => {
  if (restarting) return "#FF9500";
  if (status === "running") return "#34C759";
  if (status === "paused") return "#FF9500";
  if (status === "failed") return "#DC2626";
  return "#999";
};

export const getBotStatusLabel = (status: OpenClawBot["status"], restarting = false) => {
  if (restarting) return t("重启中...");
  if (status === "running") return t("在线");
  if (status === "paused") return t("离线");
  if (status === "failed") return t("创建失败");
  if (status === "deleting") return t("删除中");
  if (status === "provisioning") return t("创建中");
  return t("草稿");
};
