import { describe, expect, it, vi } from "vitest";

import { buildBuddySetupPlan } from "@/pages/marketing/agent-buddy-setup";
import {
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
