/**
 * LightVelaPanel commandExecutor 适配器
 *
 * ## 背景
 *
 * AgentChat-web 的 `LightVelaPanel`（公共层 `ClawPanel`）允许业务方注入
 * `commandExecutor` 自定义命令下发通道。clawpro 项目（openclaw-enterprise-fronted）
 * 走腾讯云 TAT OpenAPI（异步 + 轮询 RunCommand / DescribeInvocations /
 * DescribeInvocationTasks）。
 *
 * mono2 通过统一的 debug/exec 接口；国际站由后端建立 TAT PTY 会话并直接
 * 发送 PtyExecCmdStream，国内站保持原 envd 执行链路。后端已经暴露：
 *
 *   POST /v1/instances/:botId/debug/exec
 *   body: { command, run_as_user: "agentuser", execution_backend?: "tat" }
 *
 * 后端内部自动：
 *   1. 查出该 bot 对应的 sandbox 与 cloud instance
 *   2. 国际站走 TAT PtyExecCmdStream，国内站走 envd process stream
 *   3. 等命令结束后**一次性**返回 `{ status, exit_code, output }`
 *
 * 本适配器把这个同步接口桥接成 `LightVelaPanel.commandExecutor` 期望的契约：
 *
 *   `(options) => Promise<{ taskStatus, exitCode, output, invocationId, invocationTaskId }>`
 *
 * 因为 debug/exec 是同步的，不需要 pollIntervalMs / invocationTaskId 这类
 * TAT 概念；invocationId 仅用合成字符串占位（满足 SDK 接口形状）。
 *
 * ## 流式输出
 *
 * 当前实现是同步 JSON 版本，不会触发 `onOutput`。如果后续 panel 强依赖流式进度，
 * 可切到 `agent-tat-adapter.ts` 中已实现的 SSE 版本（`postDebugExecStream`），
 * 接口契约不变。
 *
 * @see openclaw-enterprise-fronted/client/src/pages/tenant/ChatView.tsx
 *      （clawpro 的 commandExecutor 参考实现，走 TAT）
 * @see agent-tat-adapter.ts
 *      （mono2 已有的 SDK 适配器，走 debug/exec，可复用其 SSE 流式实现）
 */
import type { Repositories } from '@/repositories/types'

/** TAT 系统类型（与 LightVelaPanel.CommandExecutor 同名） */
type TatSystemType = 'Linux' | 'Windows'

/** TAT 任务状态（与 LightVelaPanel.CommandExecutor 同形） */
type TatTaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'

/**
 * commandExecutor 入参形状。
 *
 * 与 `@tencent/agentchat-claw-components` 中 `CommandExecutor` 的 options
 * 保持一致；这里就地复刻一份，避免 mono2 直接依赖 AgentChat-web 的内部模块。
 */
interface CommandExecutorOptions {
  instanceId: string;
  region: string;
  systemType?: TatSystemType;
  command: string;
  username?: string;
  signal?: AbortSignal;
  timeoutSeconds?: number;
  /** 流式进度回调（当前 debug/exec 同步实现不会触发） */
  onOutput?: (output: string) => void;
}

/** commandExecutor 出参形状 */
interface CommandExecuteResult {
  taskStatus: TatTaskStatus;
  exitCode?: number;
  output: string;
  invocationId: string;
  invocationTaskId: string;
}

/**
 * 把 mono debug/exec 返回的 status 归一化为 TAT 任务状态。
 *
 * 后端可能返回 SUCCESS / Succeeded / success / FAILED / Failed 等多种大小写。
 * 任何非明确成功/超时/取消的状态统一归为 FAILED，避免上层误以为还在运行。
 */
function normalizeStatus(raw: string | undefined): TatTaskStatus {
  const upper = (raw ?? '').trim().toUpperCase();
  if (upper === 'SUCCESS' || upper === 'SUCCEEDED') return 'SUCCESS';
  if (upper === 'TIMEOUT') return 'TIMEOUT';
  if (upper === 'CANCELLED' || upper === 'CANCELED') return 'CANCELLED';
  // PENDING / RUNNING 不应出现在同步接口的最终响应里；若出现按 FAILED 处理
  return 'FAILED';
}

/**
 * 创建 LightVelaPanel 用的 commandExecutor。
 *
 * @param repositories  mono2 仓储层（来自 `useRepositories()`）
 * @param botId         当前 activeBot.id；mono debug/exec 的 path param
 *                      就是 botId，此处闭包绑定即可
 *
 * @example
 * ```ts
 * const lightvelaCommandExecutor = useMemo(
 *   () => activeBotId
 *     ? createLightVelaCommandExecutor(repositories, activeBotId)
 *     : undefined,
 *   [repositories, activeBotId],
 * );
 *
 * <LightVelaPanel commandExecutor={lightvelaCommandExecutor} ... />
 * ```
 */
export function createLightVelaCommandExecutor(
  repositories: Repositories,
  botId: string,
) {
  return async (options: CommandExecutorOptions): Promise<CommandExecuteResult> => {
    const { command, signal } = options;

    // 调用前先校验取消信号
    if (signal?.aborted) {
      const err = new Error('命令执行已取消');
      err.name = 'AbortError';
      throw err;
    }

    // mono debug/exec 是同步接口：国际站走 TAT PTY，国内站走 envd；命令结束后
    // 一次性返回 { status, exitCode, output }。无需轮询。
    const result = await repositories.bots.execDebugCommand(botId, command);

    // 调用后再校验一次：长命令期间用户可能已取消
    if (signal?.aborted) {
      const err = new Error('命令执行已取消');
      err.name = 'AbortError';
      throw err;
    }

    // 合成 invocationId 占位（debug/exec 没有真正的 TAT InvocationId）
    const invocationId = `mono-debug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return {
      taskStatus: normalizeStatus(result.status),
      exitCode: result.exitCode,
      output: result.output ?? '',
      invocationId,
      invocationTaskId: invocationId,
    };
  };
}
