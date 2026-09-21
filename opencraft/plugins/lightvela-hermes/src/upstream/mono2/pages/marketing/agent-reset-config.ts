// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * 恢复平台默认模型配置相关的纯逻辑函数。
 *
 * 从 agent-settings-page.tsx 中提取，方便单元测试覆盖：
 * - 前置守卫（实例状态 / 进行中防抖）
 * - acli 命令链路用到的 model id 拼接
 * - execDebugCommand 返回值的统一成功判定
 * - 错误展示的输出片段截断
 *
 * LLMGateway 通过 user/purpose=default 幂等返回平台 Key；旧 ai-gateway
 * 是否允许重置由 CTL 最终判断，前端只负责当前 Profile 的状态门禁。
 */

export interface ResettableBot {
  id: string;
  status: "running" | "paused" | "draft" | "provisioning" | "failed" | "deleting";
}

/**
 * 判断是否允许发起重置。
 * 返回 null 表示允许，否则返回拒绝原因。
 *
 * 守卫条件：
 *  - 必须有活跃 bot
 *  - 不能正在重置（防抖）
 *  - 必须 running：Profile helper 需要在 sandbox 上读取并更新 Hermes 配置
 */
export const RESET_BLOCK_REASON = {
  NO_ACTIVE_BOT: "no_active_bot",
  ALREADY_RESETTING: "already_resetting",
  NOT_RUNNING: "not_running",
} as const;

export type ResetBlockReason = (typeof RESET_BLOCK_REASON)[keyof typeof RESET_BLOCK_REASON];

export const ACLI_RESET_COMMAND =
  "acli bundle-update && acli backend upgrade-start --blueprint-id latest --wait=true --force=true";

export function getResetBlockReason(
  activeBot: ResettableBot | undefined,
  resetting: boolean,
): ResetBlockReason | null {
  if (!activeBot) return "no_active_bot";
  if (resetting) return "already_resetting";
  if (activeBot.status !== "running") return "not_running";
  return null;
}

export function getAcliResetBlockReason(
  activeBot: ResettableBot | undefined,
  resetting: boolean,
): ResetBlockReason | null {
  if (!activeBot) return "no_active_bot";
  if (resetting) return "already_resetting";
  if (activeBot.status !== "running") return "not_running";
  return null;
}

export type AcliResetClickAction = "open_confirm" | "blocked";

export function getAcliResetClickAction(
  activeBot: ResettableBot | undefined,
  resetting: boolean,
): AcliResetClickAction {
  return getAcliResetBlockReason(activeBot, resetting) === null ? "open_confirm" : "blocked";
}

/**
 * 命令是否执行成功 —— `execDebugCommand` 在不同链路可能返回 SUCCESS / Succeeded / success，
 * 统一向上比较，且 exitCode 必须是 0。
 */
export function isExecCommandSucceeded(result: { status: string; exitCode: number }): boolean {
  if (result.exitCode !== 0) return false;
  const upper = (result.status || "").trim().toUpperCase();
  return upper === "SUCCESS" || upper === "SUCCEEDED";
}

/**
 * 把 execDebugCommand 的失败 output 压缩成"可在弹窗里安全展示"的片段。
 *
 * 策略：
 *  - 优先显示去掉首尾空白后的内容
 *  - 整体超长时截尾，开头加 `…` 提示用户"前文已截"
 *  - 没有 output 时回退到 status 字符串（如 `FAILED` / `TIMEOUT`）
 *
 * 之所以不直接 slice 末尾，是因为 acli 错误信息常在 stderr 顶部，
 * 末尾常是 stack trace；保留尾巴对排错更有用，但开头加 `…` 让用户感知到截断。
 */
export function truncateExecOutput(
  output: string | undefined,
  status: string,
  maxBytes = 1200,
): string {
  const trimmed = (output || "").trim();
  if (!trimmed) return status;
  if (trimmed.length <= maxBytes) return trimmed;
  return "…" + trimmed.slice(-maxBytes);
}

/**
 * 现网 CTL 版本落后于前端时，service-gateway 会把新 reset 路由返回成
 * `resource not found (NOT_FOUND)`。这和实例不存在不同，后者通常不会用
 * 这个固定英文文案；因此只把这一类错误翻译成可执行的后端发布提示。
 */
export function isResetConfigRouteMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status;
  const code = String((error as { code?: unknown }).code || "").trim().toUpperCase();
  const message = error.message.trim().toLowerCase();
  return status === 404 && code === "NOT_FOUND" && message.includes("resource not found");
}
