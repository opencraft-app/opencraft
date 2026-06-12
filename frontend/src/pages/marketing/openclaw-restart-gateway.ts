import { isExecCommandSucceeded } from "@/pages/marketing/openclaw-reset-config";

/**
 * 重启 Gateway 相关的纯逻辑函数。
 *
 * 从 openclaw-settings-page.tsx 中提取，方便单元测试覆盖
 * 前置条件、错误归属、多 bot 并行等行为。
 */

export interface RestartableBot {
  id: string;
  status: "running" | "paused" | "draft" | "provisioning" | "failed" | "deleting";
}

/**
 * 错误按 bot 维度存储：botId → 错误消息。
 * 支持多 bot 并行失败时各自保留错误信息。
 */
export type RestartErrors = Map<string, string>;

/**
 * 判断是否允许发起重启。
 * 返回 null 表示允许，否则返回拒绝原因。
 */
export function getRestartBlockReason(
  activeBot: RestartableBot | undefined,
  restartingBotIds: Set<string>,
): string | null {
  if (!activeBot) return "no_active_bot";
  if (restartingBotIds.has(activeBot.id)) return "already_restarting";
  if (activeBot.status !== "running") return "not_running";
  return null;
}

/**
 * 判断当前 tab 的 bot 是否正在重启。
 */
export function isActiveBotRestarting(
  activeBot: RestartableBot | undefined,
  restartingBotIds: Set<string>,
): boolean {
  return activeBot ? restartingBotIds.has(activeBot.id) : false;
}

/**
 * 获取当前 tab 应展示的错误消息。
 * 从 Map 中按 botId 查找。
 */
export function getActiveBotRestartError(
  activeBot: RestartableBot | undefined,
  restartErrors: RestartErrors,
): string | null {
  if (!activeBot) return null;
  return restartErrors.get(activeBot.id) ?? null;
}

/**
 * 根据 execDebugCommand 的结果构造错误消息。
 * 如果命令成功返回 null，否则返回错误消息字符串。
 */
export function buildRestartErrorMessage(
  result: { status: string; exitCode: number; output?: string },
): string | null {
  if (isExecCommandSucceeded(result)) return null;
  return "重启失败：" + (result.output || "未知错误");
}

/**
 * 设置指定 bot 的错误。返回新的 Map（不可变更新）。
 */
export function setErrorForBot(
  errors: RestartErrors,
  botId: string,
  message: string,
): RestartErrors {
  const next = new Map(errors);
  next.set(botId, message);
  return next;
}

/**
 * 清除指定 bot 的错误（发起新重启时调用）。返回新的 Map。
 */
export function clearErrorForBot(
  errors: RestartErrors,
  botId: string,
): RestartErrors {
  if (!errors.has(botId)) return errors;
  const next = new Map(errors);
  next.delete(botId);
  return next;
}
