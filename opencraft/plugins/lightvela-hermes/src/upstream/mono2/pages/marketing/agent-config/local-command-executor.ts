// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * 本地命令执行器 —— 直连 mono debug/exec，彻底脱离 SDK 的 TAT 两步式逻辑
 *
 * ## 背景
 *
 * `@tencent/tea-sdk-lightclaw/scripts` 的 `createCommandExecutor` 面向腾讯云
 * TAT OpenAPI 设计：先 `RunCommand` 拿 InvocationId，再轮询
 * `getInvocationTask`。mono2 的后端统一走同步的
 *
 *   POST /v1/instances/:botId/debug/exec
 *
 * 之前用 `agent-tat-adapter.ts` 把 debug/exec 伪装成 TAT 两步接口再喂给 SDK 的
 * executor（合成 invocationId、pending 缓存、Base64 编解码），链路冗长且脆弱。
 *
 * 本模块提供一个**接口形状完全兼容 `ICommandExecutor`** 的本地实现，内部直接调
 * `repositories.bots.execDebugCommand` / `execDebugCommandStream`（与 chat /
 * skill / diagnostics 面板同一条「直连」链路），一步到位：
 *
 *   run(options)          → execDebugCommand(botId, command)                → { success, output }
 *   runWithProgress(opts) → execDebugCommandStream(botId, command, onChunk) → { success, output }
 *
 * 上游 6 个 hook（useGatewayCommand / useModelOperations / useChannelOperations /
 * useAgentConfig …）与 HermesQrCodeModal 只消费 `executor.run` /
 * `executor.runWithProgress` 的形状，故**零改动**即可复用本 executor。
 */
import type { Repositories } from "../../../repositories/types";
import type { DebugExecCommandLifecycle } from "../agent-debug-exec-lifecycle";

// ────────────────────────────────────────────────────────────
// 接口类型（本地权威定义，形状对齐原 SDK ICommandExecutor）
//
// 迁移前这些类型从 `@tencent/tea-sdk-lightclaw/scripts` import；脱离 SDK 后
// 由本模块提供，供 agent-config 全局复用。
// ────────────────────────────────────────────────────────────

/** 执行命令选项 */
export interface IExecuteCommandOptions {
  /** 要执行的命令字符串 */
  command: string;
  /** 超时时间（秒），默认 60 */
  timeout?: number;
  /**
   * 单次调用以指定用户名下发命令（覆盖 executor 创建时的 runAs）
   * mono debug/exec 固定以 agentuser 执行（见 createDebugExecRequestBody），
   * 该字段仅为兼容 SDK 形状保留，当前实现不透传。
   */
  runAs?: string;
}

/** 流式执行命令选项 */
export interface IExecuteCommandWithProgressOptions extends IExecuteCommandOptions {
  /** 进度回调，流式执行中每次返回**当前累积输出**（明文） */
  onProgress?: (output: string) => void;
  /**
   * 最大轮询次数（SDK TAT 轮询语义）。debug/exec 为流式推送，无需轮询；
   * 仅为兼容 SDK 形状保留，当前实现忽略。
   */
  maxRetries?: number;
}

/** 命令执行结果 */
export interface ICommandResult {
  /** 是否成功（退出码为 0 且状态为成功态） */
  success: boolean;
  /** 命令输出（已 trim） */
  output: string;
}

/** 命令执行器实例 */
export interface ICommandExecutor {
  /** 执行一条命令（等待完成后返回） */
  run: (options: IExecuteCommandOptions) => Promise<ICommandResult>;
  /** 流式执行一条命令（执行中实时回调累积输出） */
  runWithProgress: (options: IExecuteCommandWithProgressOptions) => Promise<ICommandResult>;
}

/** 本地执行器配置 */
export interface ILocalCommandExecutorConfig {
  /** mono2 仓储层（来自 `useRepositories()`） */
  repositories: Repositories;
  /** 目标 bot id（mono debug/exec 的 path param），即 SDK 语境下的 instance.InstanceId */
  botId: string;
  /**
   * 命令生命周期钩子（可选）。
   * 用于在命令下发前后插入业务逻辑（改写命令 / 执行前准备 / 执行后同步），
   * 如自动化模型切换同步、QQ 群策略注入。
   */
  commandLifecycle?: DebugExecCommandLifecycle;
}

/** 命令超时秒 → 毫秒，默认 60s；<=0 视为不限时 */
function toTimeoutMs(timeoutSeconds?: number): number | undefined {
  const seconds = typeof timeoutSeconds === "number" ? timeoutSeconds : 60;
  return seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * 判定命令是否成功。
 *
 * debug/exec 返回 `{ status, exitCode, output }`。SDK 的 `ICommandResult.success`
 * 语义是「退出码为 0」。这里综合退出码 + 归一化状态：退出码 0 且状态非明确失败态
 * 即视为成功，与 agent-command-executor.ts 的 normalizeStatus 保持一致。
 */
function isSuccess(status: string, exitCode: number): boolean {
  const upper = (status ?? "").trim().toUpperCase();
  if (upper === "FAILED" || upper === "TIMEOUT" || upper === "CANCELLED" || upper === "CANCELED") {
    return false;
  }
  return exitCode === 0;
}

/**
 * 创建本地命令执行器。
 *
 * @example
 * ```ts
 * const executor = createLocalCommandExecutor({ repositories, botId: activeBot.id });
 * const { success, output } = await executor.run({ command: "acli gateway status" });
 * ```
 */
export function createLocalCommandExecutor(
  config: ILocalCommandExecutorConfig,
): ICommandExecutor {
  const { repositories, botId, commandLifecycle } = config;

  /** 应用 transformCommand 钩子，返回最终待执行命令 */
  async function resolveCommand(command: string): Promise<string> {
    const transformed = await commandLifecycle?.transformCommand?.({ botId, command });
    return transformed ?? command;
  }

  return {
    async run(options: IExecuteCommandOptions): Promise<ICommandResult> {
      const command = await resolveCommand(options.command);
      const metadata = await commandLifecycle?.beforeExecute?.({ botId, command });
      const result = await repositories.bots.execDebugCommand(botId, command, {
        timeoutMs: toTimeoutMs(options.timeout),
      });
      await commandLifecycle?.afterExecute?.({
        botId,
        command,
        metadata,
        result: {
          status: result.status,
          exitCode: result.exitCode,
          output: result.output ?? "",
        },
      });
      return {
        success: isSuccess(result.status, result.exitCode),
        output: (result.output ?? "").trim(),
      };
    },

    async runWithProgress(
      options: IExecuteCommandWithProgressOptions,
    ): Promise<ICommandResult> {
      const command = await resolveCommand(options.command);
      const { timeout, onProgress } = options;
      const metadata = await commandLifecycle?.beforeExecute?.({ botId, command });
      // 累积输出：execDebugCommandStream 回调的是**增量 chunk**，而 SDK 的
      // onProgress 契约是**当前累积输出**（明文），故此处自行累积后回调。
      let accumulated = "";
      const result = await repositories.bots.execDebugCommandStream(
        botId,
        command,
        ({ chunk }) => {
          if (!chunk) return;
          accumulated += chunk;
          onProgress?.(accumulated);
        },
        { timeoutMs: toTimeoutMs(timeout) },
      );
      await commandLifecycle?.afterExecute?.({
        botId,
        command,
        metadata,
        result: {
          status: result.status,
          exitCode: result.exitCode,
          output: result.output ?? "",
        },
      });
      return {
        success: isSuccess(result.status, result.exitCode),
        output: (result.output ?? "").trim(),
      };
    },
  };
}
