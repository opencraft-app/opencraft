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
import { buildSetupStepKey } from "@/pages/marketing/agent-buddy-setup-progress";

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
 * 这次失败是否值得重试。
 *
 * 只认「请求没能完成」这一类：fetch 抛 TypeError（Failed to fetch）、被
 * RepositoryError 包成 network_error、或沙箱侧超时。这些都跟命令本身对不对
 * 无关，重跑一次很可能就过了。
 *
 * 反过来，命令已经执行、只是结果失败（技能不存在、slug 拼错、magic 校验
 * 不通过）绝不能重试 —— 重跑一百次也是同样的错，只是让用户多等。
 *
 * 真实背景：本地用 whistle 做系统代理时，创建 Bot 的技能安装这一步稳定报
 * `TypeError: Failed to fetch`，而同一个技能在技能页手动装能成功。技能安装
 * 是整条计划里唯一的长耗时请求（要下载+解压），等待响应期间连接是空闲的，
 * 容易被代理按空闲超时切断。前后几步都是秒级请求，所以只有它中招。
 */
export const isRetriableSetupFailure = (error: unknown): boolean => {
  if (error instanceof Error) {
    // 沙箱执行超时：上层用 debug_exec_timeout:<ms> 这个形态传递
    if (error.message.startsWith("debug_exec_timeout:")) return true;
    // RepositoryError 带 code；用鸭子类型判断，避免为此从 repositories 引类型
    const code = (error as Error & { code?: string }).code;
    if (code === "network_error") return true;
    if (error.name === "TypeError" && /failed to fetch|networkerror|load failed/i.test(error.message)) {
      return true;
    }
    // 经 createNetworkUnavailableError 包装后，原因会附在 message 里
    if (/failed to fetch/i.test(error.message)) return true;
  }
  return false;
};

/** 重试间隔：立刻再试一次，仍失败则等 2s、5s。总共最多 4 次尝试 */
const RETRY_DELAYS_MS = [0, 2_000, 5_000] as const;

const sleep = (ms: number) => (ms > 0
  ? new Promise<void>((resolve) => { setTimeout(resolve, ms); })
  : Promise.resolve());

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
  /**
   * 上一次已经跑成功的步骤 key（见 agent-buddy-setup-progress）。
   *
   * 用于「写配置写到一半刷新页面」后的续跑：命中的步骤直接标 done 并跳过
   * 执行，只补没做完的。
   *
   * 为什么必须跳过而不是无脑重跑：SOUL 与 profile 是覆盖写，重跑无害；
   * 但 `hermes cron create` 没有 upsert 语义，重跑会把同一条定时任务
   * 再建一遍，用户的任务列表里会出现两条一模一样的。
   */
  completedKeys?: ReadonlySet<string>;
}): Promise<SetupRunResult> => {
  const { botId, steps, exec, onProgress, shouldCancel, completedKeys } = params;

  const states: SetupStepState[] = steps.map((step) => ({ step, status: "pending" }));
  const emit = () => onProgress?.(states.map((state) => ({ ...state })));

  /*
   * 续跑：先把已完成的步骤标上。
   *
   * 在首次 emit 之前做完，这样 UI 第一帧就显示「前 4 步已完成」，
   * 而不是先闪一遍全 pending 再跳成已完成。
   */
  if (completedKeys?.size) {
    for (let index = 0; index < states.length; index += 1) {
      if (completedKeys.has(buildSetupStepKey(states[index]!.step, index))) {
        states[index]!.status = "done";
      }
    }
  }
  emit();

  for (let index = 0; index < states.length; index += 1) {
    if (shouldCancel?.()) break;

    const current = states[index]!;
    // 续跑跳过：上一次已经成功，不重复执行（cron 尤其不能重跑）
    if (current.status === "done") continue;
    current.status = "running";
    emit();

    /*
     * 网络类失败重试。
     *
     * 只对 isRetriableSetupFailure 认定的「请求没完成」重试；命令已执行但结果
     * 失败的情况直接落败，不浪费用户时间。
     */
    let lastError: unknown;
    let succeeded = false;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) {
        // 取消要在等待前后都检查，避免组件已卸载还在空转
        if (shouldCancel?.()) break;
        await sleep(RETRY_DELAYS_MS[attempt - 1]!);
        if (shouldCancel?.()) break;
      }

      try {
        const result = await exec(botId, current.step.command, {
          timeoutMs: current.step.timeoutMs,
        });
        if (!isSetupCommandSucceeded(result)) {
          // 命令跑完了但结果不对 —— 这不是网络问题，不再重试
          lastError = new Error(truncateSetupError(result.output, result.status));
          break;
        }
        succeeded = true;
        break;
      } catch (error) {
        lastError = error;
        if (!isRetriableSetupFailure(error)) break;
      }
    }

    if (succeeded) {
      current.status = "done";
      emit();
      continue;
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    current.status = "failed";
    current.error = message;
    emit();

    if (current.step.required) {
      // 身份没写成功，后面装技能/建任务都没有意义
      throw new Error(message);
    }
  }

  return {
    states: states.map((state) => ({ ...state })),
    failures: states.filter((state) => state.status === "failed").map((state) => ({ ...state })),
  };
};
