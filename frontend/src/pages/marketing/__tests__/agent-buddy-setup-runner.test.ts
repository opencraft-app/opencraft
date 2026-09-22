import { describe, expect, it, vi } from "vitest";

import { buildBuddySetupPlan } from "@/pages/marketing/agent-buddy-setup";
import {
  isRetriableSetupFailure,
  isSetupCommandSucceeded,
  runBuddySetupPlan,
  truncateSetupError,
  type SetupExec,
  type SetupStepState,
} from "@/pages/marketing/agent-buddy-setup-runner";
import { DEMO_TEMPLATES } from "@/pages/marketing/agent-demo-templates";

const profile = { name: "我的 Hermes", tags: "内容创作", description: "帮我处理日常" };
const template = DEMO_TEMPLATES[0]!;

const plan = () => buildBuddySetupPlan({ profile, template, timestamp: "20260914" });

const ok = { status: "success", exitCode: 0, output: "" };
const fail = { status: "failed", exitCode: 1, output: "boom" };

describe("isSetupCommandSucceeded", () => {
  it("requires exit code 0", () => {
    expect(isSetupCommandSucceeded({ status: "success", exitCode: 0 })).toBe(true);
    expect(isSetupCommandSucceeded({ status: "success", exitCode: 1 })).toBe(false);
  });

  it("rejects failure-flavoured statuses even on exit code 0", () => {
    // 沙箱偶发 exitCode 0 但 status 表达失败，必须一并拦住
    expect(isSetupCommandSucceeded({ status: "TIMEOUT", exitCode: 0 })).toBe(false);
    expect(isSetupCommandSucceeded({ status: "COMMAND_FAILED", exitCode: 0 })).toBe(false);
    expect(isSetupCommandSucceeded({ status: "some error", exitCode: 0 })).toBe(false);
  });
});

describe("truncateSetupError", () => {
  it("keeps short output as-is", () => {
    expect(truncateSetupError("boom", "failed")).toBe("boom");
  });

  it("falls back to status when output is empty", () => {
    expect(truncateSetupError("", "TIMEOUT")).toBe("TIMEOUT");
  });

  it("truncates long output", () => {
    const result = truncateSetupError("x".repeat(500), "failed");
    expect(result.length).toBeLessThan(500);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("runBuddySetupPlan", () => {
  it("executes every step in order with its own timeout", async () => {
    const steps = plan();
    const exec = vi.fn<SetupExec>().mockResolvedValue(ok);

    const result = await runBuddySetupPlan({ botId: "bot-1", steps, exec });

    expect(exec).toHaveBeenCalledTimes(steps.length);
    expect(exec.mock.calls.map((call) => call[1])).toEqual(steps.map((step) => step.command));
    expect(exec.mock.calls[0]![2]).toEqual({ timeoutMs: steps[0]!.timeoutMs });
    expect(result.states.every((state) => state.status === "done")).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("reports progress snapshots as steps advance", async () => {
    const steps = plan();
    const snapshots: SetupStepState[][] = [];
    const exec = vi.fn<SetupExec>().mockResolvedValue(ok);

    await runBuddySetupPlan({
      botId: "bot-1",
      steps,
      exec,
      onProgress: (states) => snapshots.push(states),
    });

    // 首帧全 pending，末帧全 done
    expect(snapshots[0]!.every((state) => state.status === "pending")).toBe(true);
    expect(snapshots.at(-1)!.every((state) => state.status === "done")).toBe(true);
    // 中途必须出现过 running，否则 UI 没有"正在做什么"可显示
    expect(snapshots.some((frame) => frame.some((state) => state.status === "running"))).toBe(true);
  });

  it("hands out defensive copies so callers cannot mutate internal state", async () => {
    const steps = plan();
    const exec = vi.fn<SetupExec>().mockResolvedValue(ok);
    const snapshots: SetupStepState[][] = [];

    await runBuddySetupPlan({
      botId: "bot-1",
      steps,
      exec,
      onProgress: (states) => {
        // 只污染第一帧，验证后续帧不受影响
        if (snapshots.length === 0) states[0]!.status = "failed";
        snapshots.push(states);
      },
    });

    expect(snapshots[0]![0]!.status).toBe("failed"); // 外部改动只留在自己手里的副本
    expect(snapshots.at(-1)![0]!.status).toBe("done"); // 内部状态未被污染
  });

  it("aborts the whole run when a required step fails", async () => {
    const steps = plan();
    // 第一步是 SOUL（required）
    const exec = vi.fn<SetupExec>().mockResolvedValue(fail);

    await expect(runBuddySetupPlan({ botId: "bot-1", steps, exec })).rejects.toThrow("boom");
    // 失败即止，不继续装技能
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("keeps going when an optional step fails and collects it", async () => {
    const steps = plan();
    const exec = vi.fn<SetupExec>().mockImplementation(async (_botId, command) => (
      command.includes("acli skills install") ? fail : ok
    ));

    const result = await runBuddySetupPlan({ botId: "bot-1", steps, exec });

    // 所有步骤都跑过
    expect(exec).toHaveBeenCalledTimes(steps.length);
    const skillFailures = result.failures.filter((state) => state.step.kind === "skill");
    expect(skillFailures.length).toBe(template.skills.length);
    // 人设仍然成功
    expect(result.states[0]!.status).toBe("done");
  });

  it("records the error message on the failed step", async () => {
    const steps = plan();
    const exec = vi.fn<SetupExec>().mockImplementation(async (_botId, command) => (
      command.includes(" cron create") ? fail : ok
    ));

    const result = await runBuddySetupPlan({ botId: "bot-1", steps, exec });
    const cronFailure = result.failures.find((state) => state.step.kind === "cron");
    expect(cronFailure?.error).toBe("boom");
  });

  it("surfaces thrown exec errors rather than swallowing them", async () => {
    const steps = plan();
    const exec = vi.fn<SetupExec>().mockRejectedValue(new Error("network down"));

    await expect(runBuddySetupPlan({ botId: "bot-1", steps, exec })).rejects.toThrow("network down");
  });

  it("stops early when cancelled", async () => {
    const steps = plan();
    const exec = vi.fn<SetupExec>().mockResolvedValue(ok);
    let calls = 0;

    await runBuddySetupPlan({
      botId: "bot-1",
      steps,
      exec,
      shouldCancel: () => {
        calls += 1;
        return calls > 2;
      },
    });

    expect(exec.mock.calls.length).toBeLessThan(steps.length);
  });
});

/*
 * 网络类失败重试。
 *
 * 真实故障：本地用 whistle 做系统代理时，创建 Bot 的「安装技能」这一步稳定报
 * `TypeError: Failed to fetch`，同一技能在技能页手动装却能成功。技能安装是整条
 * 计划里唯一的长耗时请求（下载+解压），等响应期间连接空闲，容易被代理按空闲
 * 超时切断；前后几步都是秒级请求所以不中招。
 *
 * 专家面板早就有重试（SKILL_INSTALL_*_RETRY_DELAYS_MS），创建流程一直没有 ——
 * 这里补上，并守住「只重试网络失败，不重试业务失败」的边界。
 */
describe("retry on transient network failures", () => {
  const netError = () => {
    const error = new TypeError("Failed to fetch");
    return error;
  };

  /*
   * 不能用文件顶部那个 template（DEMO_TEMPLATES[0] 是健康管家，skills 为空，
   * 计划里根本没有 skill 步骤）。这里挑一个确实带技能的模板。
   */
  const templateWithSkills = DEMO_TEMPLATES.find((item) => item.skills.length > 0)!;
  const skillPlan = () => buildBuddySetupPlan({
    profile,
    template: templateWithSkills,
    timestamp: "20260914",
  });

  it("classifies only transport-level failures as retriable", () => {
    expect(isRetriableSetupFailure(netError())).toBe(true);
    expect(isRetriableSetupFailure(new Error("debug_exec_timeout:120000"))).toBe(true);
    expect(isRetriableSetupFailure(
      Object.assign(new Error("认证服务暂时不可用"), { code: "network_error" }),
    )).toBe(true);
    // 业务失败不该重试 —— 重跑一百次也是同样的错
    expect(isRetriableSetupFailure(new Error("skill not found: foo"))).toBe(false);
    expect(isRetriableSetupFailure(new Error("boom"))).toBe(false);
  });

  it("retries a flaky skill install and succeeds without failing the step", async () => {
    const steps = skillPlan();
    const skillStep = steps.find((step) => step.kind === "skill")!;
    let skillAttempts = 0;
    const exec = vi.fn<SetupExec>().mockImplementation(async (_botId, command) => {
      if (command !== skillStep.command) return ok;
      skillAttempts += 1;
      // 前两次网络失败，第三次成功
      if (skillAttempts < 3) throw netError();
      return ok;
    });

    const result = await runBuddySetupPlan({ botId: "bot-1", steps, exec });

    expect(skillAttempts).toBe(3);
    expect(result.failures).toHaveLength(0);
    const skillState = result.states.find((state) => state.step.kind === "skill");
    expect(skillState?.status).toBe("done");
  });

  it("does not retry business failures", async () => {
    const steps = skillPlan();
    const skillStep = steps.find((step) => step.kind === "skill")!;
    let skillAttempts = 0;
    const exec = vi.fn<SetupExec>().mockImplementation(async (_botId, command) => {
      if (command !== skillStep.command) return ok;
      skillAttempts += 1;
      // 命令跑完了，只是结果失败
      return { status: "failed", exitCode: 1, output: "skill not found" };
    });

    const result = await runBuddySetupPlan({ botId: "bot-1", steps, exec });

    // 只试一次，不浪费用户 7 秒去重复一个必然失败的命令
    expect(skillAttempts).toBe(1);
    expect(result.failures.some((state) => state.step.kind === "skill")).toBe(true);
  });

  it("gives up after exhausting retries and records the last error", async () => {
    const steps = skillPlan();
    const skillStep = steps.find((step) => step.kind === "skill")!;
    let skillAttempts = 0;
    const exec = vi.fn<SetupExec>().mockImplementation(async (_botId, command) => {
      if (command !== skillStep.command) return ok;
      skillAttempts += 1;
      throw netError();
    });

    const result = await runBuddySetupPlan({ botId: "bot-1", steps, exec });

    // 首次 + 3 次重试
    expect(skillAttempts).toBe(4);
    const skillFailure = result.failures.find((state) => state.step.kind === "skill");
    expect(skillFailure?.error).toContain("Failed to fetch");
    // 非必需步骤失败不该拖垮其他步骤
    expect(result.states.filter((state) => state.status === "done").length)
      .toBe(steps.length - 1);
    /*
     * 这条要真实等完 0+2+5 秒，超过 vitest 默认的 5s，所以显式放宽到 15s。
     * 没用假定时器：runBuddySetupPlan 是 async 循环，vi.useFakeTimers 需要在
     * 每次 await 之间手动推进，测试会写得比被测逻辑还复杂，反而容易掩盖问题。
     * 8 秒的真实等待换一条能证明「重试次数上限」的断言，值得。
     */
  }, 15_000);
});
