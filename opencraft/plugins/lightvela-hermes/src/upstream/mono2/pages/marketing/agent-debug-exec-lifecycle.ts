// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * debug/exec 命令生命周期钩子
 *
 * 在命令下发前后插入业务逻辑（改写命令 / 执行前准备 / 执行后同步），
 * 由本地 `createLocalCommandExecutor` 在 run / runWithProgress 时调用。
 *
 * 迁移前这些类型定义在 `agent-tat-adapter.ts`（已随「脱离 SDK TAT」重构删除），
 * 现收敛到本模块作为 lifecycle 的单一来源。
 */

/** 命令执行上下文（钩子入参） */
export interface DebugExecCommandContext {
  botId: string;
  command: string;
}

/** 命令执行结果（afterExecute 钩子可见） */
export interface DebugExecCommandResult {
  status: string;
  exitCode: number;
  output: string;
}

/**
 * 命令生命周期钩子。
 *
 * - `transformCommand`：执行前改写命令（如注入 QQ 群策略前置命令）；返回
 *   `undefined` 表示不改写。
 * - `beforeExecute`：执行前准备，返回的 metadata 会在 `afterExecute` 中回传。
 * - `afterExecute`：执行完成后回调（如自动化模型切换同步）。
 */
export interface DebugExecCommandLifecycle {
  transformCommand?: (context: DebugExecCommandContext) => Promise<string | undefined> | string | undefined;
  beforeExecute?: (context: DebugExecCommandContext) => Promise<unknown>;
  afterExecute?: (context: DebugExecCommandContext & {
    metadata: unknown;
    result: DebugExecCommandResult;
  }) => Promise<void>;
}

type LifecycleMetadataList = unknown[];

async function applyTransform(
  lifecycle: DebugExecCommandLifecycle,
  context: DebugExecCommandContext,
): Promise<string | undefined> {
  return lifecycle.transformCommand?.(context);
}

export function composeDebugExecCommandLifecycles(
  ...lifecycles: Array<DebugExecCommandLifecycle | null | undefined>
): DebugExecCommandLifecycle {
  const activeLifecycles = lifecycles.filter((lifecycle): lifecycle is DebugExecCommandLifecycle => Boolean(lifecycle));

  return {
    transformCommand: async (context) => {
      let command = context.command;
      let transformed = false;
      for (const lifecycle of activeLifecycles) {
        const nextCommand = await applyTransform(lifecycle, { ...context, command });
        if (typeof nextCommand === "string" && nextCommand !== command) {
          command = nextCommand;
          transformed = true;
        }
      }
      return transformed ? command : undefined;
    },
    beforeExecute: async (context) => {
      const metadata: LifecycleMetadataList = [];
      for (const lifecycle of activeLifecycles) {
        metadata.push(await lifecycle.beforeExecute?.(context));
      }
      return metadata;
    },
    afterExecute: async (context) => {
      const metadata = Array.isArray(context.metadata)
        ? context.metadata
        : [];
      for (let index = 0; index < activeLifecycles.length; index += 1) {
        const lifecycle = activeLifecycles[index]!;
        await lifecycle.afterExecute?.({
          ...context,
          metadata: metadata[index],
        });
      }
    },
  };
}
