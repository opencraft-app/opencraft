import { describe, expect, it } from "vitest";

import type { CronJob } from "@/lib/hermes-cron-client";
import {
  buildScenarioSendCommands,
  formatScenarioChannelLabel,
  isScenarioOnceCronJob,
  parseEnabledScenarioChannels,
} from "../../scenario-task-cron";

describe("scenario task cron helpers", () => {
  it("parses configured notification channels from Hermes status output", () => {
    const output = JSON.stringify({
      success: true,
      data: {
        platforms: [
          { name: "wechat", status: "connected" },
          { name: "openclaw-qq", status: "ready" },
          { name: "openclaw-lark", status: "running" },
          { name: "wecom", status: "disconnected" },
        ],
      },
    });

    expect(parseEnabledScenarioChannels(output)).toEqual(new Set(["weixin", "qqbot", "feishu"]));
  });

  it("parses object-shaped channel payloads and normalizes labels", () => {
    const output = JSON.stringify({
      data: {
        channels: {
          "openclaw-whatsapp": { enabled: true },
          "openclaw-discord": "connected",
          slack: { enabled: false },
        },
      },
    });

    expect(parseEnabledScenarioChannels(output)).toEqual(new Set(["whatsapp", "discord"]));
    expect(formatScenarioChannelLabel("weixin")).toBe("微信");
    expect(formatScenarioChannelLabel("qqbot")).toBe("QQ");
    expect(formatScenarioChannelLabel("telegram")).toBe("Telegram");
  });

  it("returns null when Hermes status output has no JSON payload", () => {
    expect(parseEnabledScenarioChannels("not-json")).toBeNull();
  });

  it("detects once cron jobs by kind or displayed schedule", () => {
    expect(isScenarioOnceCronJob(makeJob({ kind: "once", display: "2026-07-10T12:00:00" }))).toBe(true);
    expect(isScenarioOnceCronJob(makeJob({ kind: "cron", display: "once at 2026-07-10 12:00" }))).toBe(true);
    expect(isScenarioOnceCronJob(makeJob({ kind: "cron", display: "2026-07-10 12:00" }))).toBe(true);
    expect(isScenarioOnceCronJob(makeJob({ kind: "cron", display: "每天 09:00" }))).toBe(false);
  });

  it("splits multi-channel deliver targets for immediate acknowledgements", () => {
    expect(buildScenarioSendCommands("wecom,qqbot", "it's ready")).toEqual([
      "hermes send --to 'wecom' 'it'\\''s ready'",
      "hermes send --to 'qqbot' 'it'\\''s ready'",
    ]);
    expect(buildScenarioSendCommands("local", "ignored")).toEqual([]);
  });
});

function makeJob(schedule: Partial<CronJob["schedule"]>): CronJob {
  return {
    id: "job-1",
    name: "任务",
    prompt: "prompt",
    schedule: {
      kind: schedule.kind ?? "cron",
      expr: schedule.expr ?? "* * * * *",
      display: schedule.display ?? "* * * * *",
    },
    skills: [],
    enabled: true,
    state: "enabled",
    deliver: "local",
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    created_at: null,
    script: "",
    effective_window: null,
    lightvela_schedule: null,
    inference_config: null,
  };
}
