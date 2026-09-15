/**
 * 配置计划执行器
 * ──────────────────────────────────────────────────────────────
 * 顺序执行 buildBuddySetupPlan 产出的步骤，逐步回报进度。
 *
 * 设计要点：
 *   - 执行器不认识 React，只接受一个 exec 函数与一个 onProgress 回调，
 *     因此可以注入假 exec 做完整单测（真实沙箱无法在 CI 里跑）。
 *   - required 步骤失败 → 整体中止并抛错（SOUL 是身份基石）。
 *   - 非 required 步骤失败 → 记入 failures 继续跑完，最后一并回报，
 *     不让"装了 1 个技能失败"把已经写好的人设一起废掉。
 */

import type { SetupStep } from "@/pages/marketing/agent-buddy-setup";

export type SetupStepStatus = "pending" | "running" | "done" | "failed";

export interface SetupStepState {
  step: SetupStep;
  status: SetupStepStatus;
  /** 失败原因（已截断），仅 failed 时存在 */
  error?: string;
}

/** 与 repositories.bots.execDebugCommand 同形，便于直接传入 */
export type SetupExec = (
  botId: string,
  command: string,
  options?: { timeoutMs?: number },
) => Promise<{ status: string; exitCode: number; output: string }>;

export interface SetupRunResult {
  /** 全部步骤的终态，顺序与计划一致 */
  states: SetupStepState[];
  /** 非阻断步骤的失败项，用于「稍后重试」提示 */
  failures: SetupStepState[];
}

/** 命令是否算成功：exitCode 0 且 status 不是失败语义 */
export const isSetupCommandSucceeded = (result: {
  status: string;
  exitCode: number;
}): boolean => (
  result.exitCode === 0 && !/fail|error|timeout/i.test(result.status)
);

/** 截断命令输出，避免把整屏日志塞进 UI */
export const truncateSetupError = (output: string, status: string, max = 300): string => {
  const text = (output || status || "").trim();
  if (text.length <= max) return text || status;
  return `${text.slice(0, max)}…`;
};

/**
 * 按序执行配置计划。
 *
 * @throws 当某个 required 步骤失败时抛出，states 通过 onProgress 已回报给 UI
 */
export const runBuddySetupPlan = async (params: {
  botId: string;
  steps: SetupStep[];
  exec: SetupExec;
  /** 每次状态变化都会调用，传入全量快照便于直接渲染 */
  onProgress?: (states: SetupStepState[]) => void;
  /** 允许外部取消（组件卸载） */
  shouldCancel?: () => boolean;
}): Promise<SetupRunResult> => {
  const { botId, steps, exec, onProgress, shouldCancel } = params;

  const states: SetupStepState[] = steps.map((step) => ({ step, status: "pending" }));
  const emit = () => onProgress?.(states.map((state) => ({ ...state })));
  emit();

  for (let index = 0; index < states.length; index += 1) {
    if (shouldCancel?.()) break;

    const current = states[index]!;
    current.status = "running";
    emit();

    try {
      const result = await exec(botId, current.step.command, {
        timeoutMs: current.step.timeoutMs,
      });
      if (!isSetupCommandSucceeded(result)) {
        throw new Error(truncateSetupError(result.output, result.status));
      }
      current.status = "done";
      emit();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      current.status = "failed";
      current.error = message;
      emit();

      if (current.step.required) {
        // 身份没写成功，后面装技能/建任务都没有意义
        throw new Error(message);
      }
    }
  }

  return {
    states: states.map((state) => ({ ...state })),
    failures: states.filter((state) => state.status === "failed").map((state) => ({ ...state })),
  };
};
