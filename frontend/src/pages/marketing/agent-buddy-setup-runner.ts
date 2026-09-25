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
    // RepositoryError 带 code / status；鸭子类型判断，避免为此从 repositories 引类型
    const { code, status } = error as Error & { code?: string; status?: number };
    if (code === "network_error") return true;
    /*
     * 实例状态还没跟上（DEBUG_NOT_SUPPORTED / 409）。
     *
     * 预热探活通过只说明「那一刻」实例能跑命令，紧接着的第一条配置命令
     * 仍可能撞上状态回退。这类失败跟命令本身对不对无关，退避几秒重试通常
     * 就过了 —— 而 SOUL 是 required 步骤，不重试会让整条计划当场中止。
     */
    if (code === "DEBUG_NOT_SUPPORTED" || status === 409) return true;
    if (error.name === "TypeError" && /failed to fetch|networkerror|load failed/i.test(error.message)) {
      return true;
    }
    // 经 createNetworkUnavailableError 包装后，原因会附在 message 里
    if (/failed to fetch/i.test(error.message)) return true;
  }
  return false;
};

/**
 * 沙箱探活失败的性质。
 *
 * - `transient`：实例可能还在冷启动，继续轮询等待。
 * - `fatal`：等多久都不会自愈（鉴权失效、无权限、实例不存在、请求本身不
 *   被接受），必须立刻中止并把真实原因交给用户。
 */
export type SandboxProbeFailureKind = "transient" | "fatal";

/**
 * 判断一次沙箱探活失败该继续等还是立刻放弃。
 *
 * 真实背景：预热探活循环原先是 `catch {}` 空吞一切异常，于是 401（登录态
 * 失效）、403（无权配置该实例）、404（实例已被回收）也被当成「沙箱还没起
 * 好」，一路空转到 180s 超时，最后只报一句「实例尚未就绪，请稍后在设置页
 * 重试配置」。用户看到的是一个三分钟不动的 0/7 进度条加一句无信息量的报
 * 错，排障的人连 status 和 request_id 都拿不到。
 *
 * 分级原则：只有「请求确实被服务端受理、并且明确拒绝，且拒绝理由与时间
 * 无关」才算 fatal。其余一律 transient —— 预热本来就是在等一个还没准备好
 * 的东西，把「还没好」误判成 fatal，比多等几十秒严重得多。
 *
 * ⚠️ 加新的 fatal 判定前先确认：这个错误在实例启动完成后还会不会出现？
 * 会的话它就不是 fatal。DEBUG_NOT_SUPPORTED 就是踩过的坑，见下方注释。
 */
export const classifySandboxProbeFailure = (error: unknown): SandboxProbeFailureKind => {
  if (!(error instanceof Error)) return "transient";

  // 请求没能完成（沙箱侧超时 / 断网 / 代理掐连接）→ 实例大概只是还没起好
  if (isRetriableSetupFailure(error)) return "transient";

  // RepositoryError 带 status / code；鸭子类型判断，避免为此从 repositories 引类型
  const { status, code } = error as Error & { status?: number; code?: string };

  /*
   * DEBUG_NOT_SUPPORTED（ctl/pkg/errcode/debug.go，HTTP 409）：
   * 「debug command not supported in this instance state」。
   *
   * 这是 4xx 里的一个例外 —— 它描述的恰恰是「实例当前状态还不能跑 debug
   * 命令」，也就是预热要等的那个状态本身，实例起好后就不再出现。按 4xx
   * 一律 fatal 处理会把每一次正常的冷启动都判成失败。
   *
   * 同一约定在微信登录链路里已经存在（agent-settings-page.tsx 把
   * 409 / DEBUG_NOT_SUPPORTED 当作「实例未就绪 → 等待重试」），这里保持一致。
   */
  if (code === "DEBUG_NOT_SUPPORTED") return "transient";

  if (typeof status !== "number") return "transient";

  // 0 是 createNetworkUnavailableError 的占位值，语义是网络不可用
  if (status === 0) return "transient";
  // 408 请求超时、429 限流：都会随时间好转
  if (status === 408 || status === 429) return "transient";
  /*
   * 409 Conflict：语义是「当前状态下不能做这件事」，而状态是会变的。
   * 对预热来说这基本等同于「还没准备好」，必须继续等。
   */
  if (status === 409) return "transient";
  // 其余 4xx：请求被明确拒绝，再等一百次也是同样的响应
  if (status >= 400 && status < 500) return "fatal";
  // 5xx：服务端可能正在拉起实例，继续等
  return "transient";
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
