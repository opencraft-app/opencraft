import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listCronJobs: vi.fn(),
}));

vi.mock("@/lib/hermes-cron-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/hermes-cron-client")>(),
  listCronJobs: mocks.listCronJobs,
}));

import {
  AutomationModelSwitchDialog,
  buildPinAutomationModelsCommand,
  parseAutomationModelSyncOutput,
  parseModelSwitchTarget,
  selectAutomationModelSyncCandidates,
  useAutomationAwareModelSwitch,
} from "@/pages/marketing/agent-model-switch-automation-sync";
import { isCronJobExpired } from "@/pages/marketing/agent-automations-panel";
import type { CronJob } from "@/lib/hermes-cron-client";
import type { DebugExecCommandLifecycle } from "@/pages/marketing/agent-tat-adapter";

describe("model switch automation synchronization", () => {
  afterEach(() => {
    cleanup();
    mocks.listCronJobs.mockReset();
  });

  it("extracts the provider and full model id from the SDK model-switch command", () => {
    expect(parseModelSwitchTarget("acli model switch --model 'openrouter/google/gemini-3-flash-preview'")).toEqual({
      provider: "openrouter",
      model: "openrouter/google/gemini-3-flash-preview",
    });
    expect(parseModelSwitchTarget("acli provider save --name 'openrouter'")).toBeNull();
  });

  it("selects inference jobs whose provider or model does not match the switch target", () => {
    const candidates = selectAutomationModelSyncCandidates([
      makeCronJob("unbound", { provider: null, model: null, no_agent: false }),
      makeCronJob("provider-only", { provider: "openrouter", model: null, no_agent: false }),
      makeCronJob("fully-pinned", { provider: "openrouter", model: "google/gemini", no_agent: false }),
      makeCronJob("different-pin", { provider: "custom", model: "hy3-preview", no_agent: false }),
      makeCronJob("script-only", { provider: null, model: null, no_agent: true }),
      makeCronJob("unknown", null),
    ], { provider: "openrouter", model: "openrouter/google/gemini" });

    expect(candidates).toEqual([
      { id: "unbound", name: "job-unbound", pinProvider: true, pinModel: true },
      { id: "provider-only", name: "job-provider-only", pinProvider: false, pinModel: true },
      { id: "different-pin", name: "job-different-pin", pinProvider: true, pinModel: true },
    ]);
  });

  it("repairs jobs that the previous sync logic pinned to the normalized custom provider", () => {
    expect(selectAutomationModelSyncCandidates([
      makeCronJob("legacy-normalized", { provider: "custom", model: "hy3-preview", no_agent: false }),
    ], { provider: "tencent_hy_token_plan", model: "tencent_hy_token_plan/hy3-preview" })).toEqual([
      { id: "legacy-normalized", name: "job-legacy-normalized", pinProvider: true, pinModel: false },
    ]);
  });

  it("keeps paused and ended-window jobs but excludes completed one-time jobs", () => {
    const now = new Date("2026-07-21T20:00:00+08:00").getTime();
    const paused = makeCronJob("paused", { provider: null, model: null, no_agent: false });
    paused.enabled = false;
    paused.state = "paused";
    const expiredOnce = makeCronJob("expired-once", { provider: null, model: null, no_agent: false });
    expiredOnce.schedule = { kind: "once", expr: "once at 2026-07-21 19:00", display: "once at 2026-07-21 19:00" };
    expiredOnce.next_run_at = "2026-07-21T19:00:00+08:00";
    const endedWindow = makeCronJob("ended-window", { provider: null, model: null, no_agent: false });
    endedWindow.effective_window = { start_at: null, end_at: "2026-07-21T19:30:00+08:00" };

    const updatableJobs = [paused, expiredOnce, endedWindow]
      .filter((job) => !isCronJobExpired(job, now));

    expect(selectAutomationModelSyncCandidates(
      updatableJobs,
      { provider: "openrouter", model: "openrouter/google/gemini" },
    )).toEqual([
      { id: "paused", name: "job-paused", pinProvider: true, pinModel: true },
      { id: "ended-window", name: "job-ended-window", pinProvider: true, pinModel: true },
    ]);
  });

  it("builds a batch command with the selected provider id and calls the official cronjob update tool per job", () => {
    const command = buildPinAutomationModelsCommand([
      { id: "job-'quoted", name: "quoted", pinProvider: true, pinModel: true },
    ], { provider: "tencent_hy_token_plan", model: "tencent_hy_token_plan/hy3-preview" });

    expect(command).toContain("from tools.cronjob_tools import cronjob");
    expect(command).toContain("cronjob(action='\\''update'\\''");
    expect(command).toContain("_resolve_default_model_snapshot");
    expect(command).toContain('provider = "tencent_hy_token_plan"');
    expect(command).not.toContain("resolve_runtime_provider");
    expect(command).toContain("job-'\\''quoted");
    expect(command).not.toContain("quoted --");
  });

  it("parses partial success without rolling back successful jobs", () => {
    expect(parseAutomationModelSyncOutput(`noise\nLIGHTVELA_CRON_MODEL_SYNC={"total":3,"succeeded":2,"failed":[{"id":"job-3","error":"denied"}]}`)).toEqual({
      total: 3,
      succeeded: 2,
      failed: [{ id: "job-3", error: "denied" }],
    });
  });

  it("requires an explicit choice between chat-only switching and synchronizing affected jobs", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    render(createElement(AutomationModelSwitchDialog, {
        request: {
          target: { provider: "openrouter", model: "openrouter/google/gemini" },
          candidates: [
            { id: "job-1", name: "morning", pinProvider: true, pinModel: true },
            { id: "job-2", name: "digest", pinProvider: true, pinModel: true },
          ],
          unknownJobCount: 0,
          checkError: null,
          resolve: vi.fn(),
          reject: vi.fn(),
        },
        onCancel: vi.fn(),
        onChoose,
      }));

    expect(screen.getByRole("dialog", { name: "自动任务更新提示" })).toBeVisible();
    expect(screen.getByText("检测到 2 个自动任务需要更新。")).toBeVisible();
    expect(screen.getByText("切换模型后，如不同时更新任务使用的模型，这些任务将无法正常执行。建议同步更新，后续执行时将按新模型来消耗 Token。")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "仅切换对话模型" }));
    expect(onChoose).toHaveBeenLastCalledWith("switch-only");

    await user.click(screen.getByRole("button", { name: "同步更新自动任务" }));
    expect(onChoose).toHaveBeenLastCalledWith("sync-automations");
  });

  it("cancels the switch when the prompt is closed instead of reopening the detection-error prompt", async () => {
    const user = userEvent.setup();
    mocks.listCronJobs.mockResolvedValue([
      makeCronJob("active", { provider: null, model: null, no_agent: false }),
    ]);
    let lifecycle: DebugExecCommandLifecycle | undefined;

    function Harness() {
      const modelSwitch = useAutomationAwareModelSwitch();
      lifecycle = modelSwitch.commandLifecycle;
      return modelSwitch.confirmationDialog;
    }

    render(createElement(Harness));
    let beforeExecute!: Promise<unknown>;
    await act(async () => {
      beforeExecute = Promise.resolve(lifecycle?.beforeExecute?.({
        botId: "bot-1",
        command: "acli model switch --model 'openrouter/google/gemini'",
      }));
      await Promise.resolve();
    });

    expect(screen.getByText("检测到 1 个自动任务需要更新。")).toBeVisible();
    const cancelled = expect(beforeExecute).rejects.toThrow("已取消模型切换");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await cancelled;

    expect(screen.queryByText(/暂时无法检查自动任务/)).not.toBeInTheDocument();
    expect(mocks.listCronJobs).toHaveBeenCalledTimes(1);
  });
});

function makeCronJob(
  id: string,
  inferenceConfig: CronJob["inference_config"],
): CronJob {
  return {
    id,
    name: `job-${id}`,
    prompt: "run",
    schedule: { kind: "interval", expr: "every 1h", display: "every 1h" },
    skills: [],
    enabled: true,
    state: "active",
    deliver: "local",
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    created_at: null,
    script: "",
    effective_window: null,
    lightvela_schedule: null,
    inference_config: inferenceConfig,
  };
}
