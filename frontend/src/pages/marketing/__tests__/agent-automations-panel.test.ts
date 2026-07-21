import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildEffectiveWindowFromInputs,
  buildDeliverString,
  buildHermesSendTarget,
  buildHermesSendTestCommand,
  buildScheduleString,
  formatEffectiveWindow,
  formatEffectiveWindowPeriod,
  formatEffectiveWindowTooltipLines,
  formatScheduleTooltip,
  formatTestSendError,
  getAutomationSkillSelectionIssue,
  getTestSendFailureFallback,
  getLastAgentRunForJob,
  getEffectiveWindowStatus,
  isHermesNotificationChannelConfigured,
  isCronJobExpiredBeyondGrace,
  isEffectiveWindowRangeInvalid,
  normalizeDailyTimesForEditing,
  normalizeDailyTimesForForm,
  normalizeEffectiveWindowInput,
  parseEnabledHermesChannels,
  parseCronDate,
  parseInitialDeliver,
  parseInitialSchedule,
  parseOnceScheduleDate,
  RecentCronRunsPanel,
  sanitizeClockTimeDraft,
  shouldShowRecentRunsLimitHint,
  shouldRejectPastOnceSchedule,
  toCreateCronSkills,
  toEditCronSkills,
} from "../agent-automations-panel";
import type { CronJob, CronRunRecord } from "@/lib/hermes-cron-client";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("recent run limit hint", () => {
  it("shows the hint only when at least 10 runs are displayed", () => {
    expect(shouldShowRecentRunsLimitHint(0)).toBe(false);
    expect(shouldShowRecentRunsLimitHint(1)).toBe(false);
    expect(shouldShowRecentRunsLimitHint(9)).toBe(false);
    expect(shouldShowRecentRunsLimitHint(10)).toBe(true);
    expect(shouldShowRecentRunsLimitHint(11)).toBe(true);
  });

  it("shows model drift as an unexecuted run with a concise reason", () => {
    render(createElement(RecentCronRunsPanel, {
      runs: [makeCronRun({
        job_name: "每日工作小结",
        status: "not_executed",
        skip_reason: "model_changed",
      })],
      skillLoadState: { status: "ready", slugs: [], error: null },
    }));

    expect(screen.getByText("每日工作小结")).toBeTruthy();
    expect(screen.getByText("未执行")).toBeTruthy();
    expect(screen.getByText("问题原因：模型切换导致任务未执行")).toBeTruthy();
  });

  it("localizes the unsupported-plan model error", () => {
    render(createElement(RecentCronRunsPanel, {
      runs: [makeCronRun({
        status: "error: RuntimeError: HTTP 403: The requested model is not available in your current plan.",
      })],
      skillLoadState: { status: "ready", slugs: [], error: null },
    }));

    expect(screen.getByText("执行失败：当前模型暂不可用，请稍后重试或切换模型。")).toBeTruthy();
    expect(screen.queryByText(/The requested model is not available/)).toBeNull();
  });

  it("shows the bound Skill in the recent-run detail", () => {
    render(createElement(RecentCronRunsPanel, {
      runs: [makeCronRun({ skills: ["builder-radar"] })],
      skillLoadState: { status: "ready", slugs: ["builder-radar"], error: null },
    }));

    fireEvent.click(screen.getAllByRole("button", { name: "查看任务详情" })[0]!);

    expect(screen.getByText("调用技能")).toBeTruthy();
    expect(screen.getByText("Builder Radar")).toBeTruthy();
    expect(screen.getByText("builder-radar")).toBeTruthy();
  });

  it("shows an unconfigured Skill binding in the recent-run detail", () => {
    render(createElement(RecentCronRunsPanel, {
      runs: [makeCronRun({ skills: [] })],
      skillLoadState: { status: "ready", slugs: [], error: null },
    }));

    fireEvent.click(screen.getAllByRole("button", { name: "查看任务详情" })[0]!);

    expect(screen.getByText("调用技能")).toBeTruthy();
    expect(screen.getByText("未配置")).toBeTruthy();
  });
});

describe("automation Skill form mapping", () => {
  it("omits Skill input for ordinary tasks and stores one selected slug", () => {
    expect(toCreateCronSkills("")).toBeUndefined();
    expect(toCreateCronSkills("finance-news")).toEqual(["finance-news"]);
  });

  it("distinguishes keeping, replacing and clearing an edit binding", () => {
    expect(toEditCronSkills(["finance-news"], "finance-news")).toBeUndefined();
    expect(toEditCronSkills(["finance-news"], "market-data")).toEqual(["market-data"]);
    expect(toEditCronSkills(["finance-news"], "")).toEqual([]);
  });

  it("does not collapse an external multi-Skill task when its first binding is unchanged", () => {
    expect(toEditCronSkills(["first", "second"], "first")).toBeUndefined();
  });

  it("rejects a new or changed binding that is missing or cannot be verified", () => {
    expect(getAutomationSkillSelectionIssue({
      mode: "create",
      initialSkills: [],
      selectedSkill: "finance-news",
      initialSkillWasAvailable: null,
      verificationState: { status: "ready", slugs: [], error: null },
    })).toBe("unavailable");

    expect(getAutomationSkillSelectionIssue({
      mode: "edit",
      initialSkills: ["finance-news"],
      selectedSkill: "market-data",
      initialSkillWasAvailable: true,
      verificationState: { status: "error", slugs: ["finance-news"], error: "network failed" },
    })).toBe("unverified");
  });

  it("allows ordinary tasks and unchanged historical unavailable bindings", () => {
    expect(getAutomationSkillSelectionIssue({
      mode: "create",
      initialSkills: [],
      selectedSkill: "",
      initialSkillWasAvailable: null,
      verificationState: { status: "error", slugs: [], error: "network failed" },
    })).toBeNull();

    expect(getAutomationSkillSelectionIssue({
      mode: "edit",
      initialSkills: ["removed-skill"],
      selectedSkill: "removed-skill",
      initialSkillWasAvailable: false,
      verificationState: { status: "ready", slugs: [], error: null },
    })).toBeNull();
  });

  it("detects a binding that became unavailable while the edit form was open", () => {
    expect(getAutomationSkillSelectionIssue({
      mode: "edit",
      initialSkills: ["finance-news"],
      selectedSkill: "finance-news",
      initialSkillWasAvailable: true,
      verificationState: { status: "ready", slugs: [], error: null },
    })).toBe("unavailable");
  });
});

describe("buildScheduleString and parseInitialSchedule", () => {
  it("round-trips daily schedules", () => {
    const schedule = buildScheduleString({
      kind: "recurring",
      period: "daily",
      time: "09:05",
      weekday: 1,
      monthday: 1,
      intervalNum: 1,
      intervalUnit: "h",
      onceDate: "",
    });

    expect(schedule).toBe("5 9 * * *");
    expect(parseInitialSchedule(schedule)).toMatchObject({
      kind: "recurring",
      period: "daily",
      time: "09:05",
    });
  });

  it("uses one minute-level cron job for daily schedules with multiple time points", () => {
    const schedule = buildScheduleString({
      kind: "recurring",
      period: "daily",
      time: "09:00",
      dailyTimes: ["09:00", "12:30"],
      weekday: 1,
      monthday: 1,
      intervalNum: 1,
      intervalUnit: "h",
      onceDate: "",
    });

    expect(schedule).toBe("* * * * *");
  });

  it("keeps daily time form edits in input order", () => {
    expect(normalizeDailyTimesForForm(["01:06", "14:06"], "01:06")).toEqual(["01:06", "14:06"]);
    expect(normalizeDailyTimesForForm(["14:06", "01:06"], "14:06")).toEqual(["14:06", "01:06"]);
  });

  it("keeps daily time edits within valid clock bounds", () => {
    expect(normalizeDailyTimesForEditing(["01:06", "", "14:06"], "01:06")).toEqual(["01:06", "01:06", "14:06"]);
    expect(normalizeDailyTimesForForm(["01:06", "", "14:06"], "01:06")).toEqual(["01:06", "14:06"]);
  });

  it("normalizes partial and out-of-range daily time drafts while editing", () => {
    expect(sanitizeClockTimeDraft("ab12:3x")).toBe("12:3");
    expect(normalizeDailyTimesForEditing(["01:06", "1", "12:", "12:3", "19:99", "99:99"], "01:06")).toEqual([
      "01:06",
      "01:06",
      "12:06",
      "12:03",
      "19:59",
      "23:59",
    ]);
    expect(normalizeDailyTimesForForm(["01:06", "1", "12:", "12:3"], "01:06")).toEqual(["01:06"]);
  });

  it("round-trips weekly and monthly schedules", () => {
    expect(parseInitialSchedule(buildScheduleString({
      kind: "recurring",
      period: "weekly",
      time: "18:30",
      weekdays: [1, 3, 5],
      monthday: 1,
      intervalNum: 1,
      intervalUnit: "h",
      onceDate: "",
    }))).toMatchObject({ kind: "recurring", period: "weekly", time: "18:30", weekday: 1, weekdays: [1, 3, 5] });

    // 单日 weekly 也需 round-trip：避免 buildScheduleString 单元素分支退化
    expect(parseInitialSchedule(buildScheduleString({
      kind: "recurring",
      period: "weekly",
      time: "09:00",
      weekdays: [3],
      monthday: 1,
      intervalNum: 1,
      intervalUnit: "h",
      onceDate: "",
    }))).toMatchObject({ kind: "recurring", period: "weekly", time: "09:00", weekday: 3, weekdays: [3] });

    const monthlySchedule = buildScheduleString({
      kind: "recurring",
      period: "monthly",
      time: "07:00",
      weekday: 1,
      monthday: 28,
      intervalNum: 1,
      intervalUnit: "h",
      onceDate: "",
    });
    expect(monthlySchedule).toBe("0 7 28 * *");
    expect(parseInitialSchedule(monthlySchedule)).toMatchObject({
      kind: "recurring",
      period: "monthly",
      time: "07:00",
      monthday: 28,
      monthdays: [28],
    });
  });

  it("round-trips monthly schedules with multiple days", () => {
    const schedule = buildScheduleString({
      kind: "recurring",
      period: "monthly",
      time: "09:00",
      weekdays: [1],
      monthdays: [14, 6, 7],
      intervalNum: 1,
      intervalUnit: "h",
      onceDate: "",
    });

    expect(schedule).toBe("0 9 6,7,14 * *");
    expect(parseInitialSchedule(schedule)).toMatchObject({
      kind: "recurring",
      period: "monthly",
      time: "09:00",
      monthday: 6,
      monthdays: [6, 7, 14],
    });
  });

  it("round-trips interval and once schedules", () => {
    expect(parseInitialSchedule(buildScheduleString({
      kind: "interval",
      period: "daily",
      time: "09:00",
      weekday: 1,
      monthday: 1,
      intervalNum: 5,
      intervalUnit: "m",
      onceDate: "",
    }))).toMatchObject({ kind: "interval", intervalNum: 5, intervalUnit: "m" });

    expect(parseInitialSchedule(buildScheduleString({
      kind: "once",
      period: "daily",
      time: "09:00",
      weekday: 1,
      monthday: 1,
      intervalNum: 1,
      intervalUnit: "h",
      onceDate: "2026-05-26T22:09",
    }))).toMatchObject({ kind: "once", onceDate: "2026-05-26T22:09" });
  });

  it("does not coerce unsupported cron expressions into editable defaults", () => {
    expect(parseInitialSchedule("*/5 * * * *")).toBeNull();
    expect(parseInitialSchedule("0 9 * * 1-5")).toBeNull();
    expect(parseInitialSchedule("0 9-18 * * *")).toBeNull();
  });

  it("parses comma-separated weekly cron weekdays", () => {
    expect(parseInitialSchedule("0 9 * * 1,3,4,5,6,0")).toMatchObject({
      kind: "recurring",
      period: "weekly",
      time: "09:00",
      weekday: 1,
      weekdays: [1, 3, 4, 5, 6, 0],
    });
  });

  it("treats cron weekday 7 as Sunday (0)", () => {
    expect(parseInitialSchedule("0 9 * * 7")).toMatchObject({
      kind: "recurring",
      period: "weekly",
      time: "09:00",
      weekdays: [0],
    });
  });
});

describe("parseInitialDeliver", () => {
  it("treats empty and local deliver targets as no notification", () => {
    expect(parseInitialDeliver("")).toEqual({ platforms: [], chatIds: {} });
    expect(parseInitialDeliver("local")).toEqual({ platforms: [], chatIds: {} });
  });

  it("parses platform list and chat ids", () => {
    expect(parseInitialDeliver("weixin:wx_123,feishu:oc_123,qqbot:qq_123")).toEqual({
      platforms: ["weixin", "feishu", "qqbot"],
      chatIds: { weixin: "wx_123", feishu: "oc_123", qqbot: "qq_123" },
    });
  });

  it("preserves origin and unknown deliver targets as passthrough platforms", () => {
    expect(parseInitialDeliver("origin:oc_123,telegram:tg_123,weixin")).toEqual({
      platforms: ["origin", "telegram", "weixin"],
      chatIds: { origin: "oc_123", telegram: "tg_123" },
    });
  });

  it("round-trips chat ids for every supported platform", () => {
    const deliver = "weixin:wx_123,qqbot:qq_123,feishu:oc_123,origin:oc_origin";
    const parsed = parseInitialDeliver(deliver);

    expect(buildDeliverString(parsed.platforms, parsed.chatIds)).toBe(deliver);
  });

  it("omits chat ids for unchecked platforms", () => {
    const parsed = parseInitialDeliver("weixin:wx_123,qqbot:qq_123,feishu:oc_123");

    expect(buildDeliverString(["weixin", "feishu"], parsed.chatIds)).toBe("weixin:wx_123,feishu:oc_123");
  });
});

describe("buildHermesSendTestCommand", () => {
  it("uses the platform home target when chat id is empty", () => {
    expect(buildHermesSendTarget("feishu", "")).toBe("feishu");
    expect(buildHermesSendTestCommand("feishu", "", "deploy finished")).toBe(
      "hermes send --to 'feishu' 'deploy finished'",
    );
  });

  it("uses platform:chat_id target when chat id is provided", () => {
    expect(buildHermesSendTarget("feishu", " oc_123 ")).toBe("feishu:oc_123");
    expect(buildHermesSendTestCommand("feishu", "oc_123", "it's ready")).toBe(
      "hermes send --to 'feishu:oc_123' 'it'\\''s ready'",
    );
  });
});

describe("parseEnabledHermesChannels", () => {
  const channelStatusPayload = JSON.stringify({
    success: true,
    data: {
      platforms: [
        { name: "weixin", status: "connected" },
        { name: "qqbot", status: "disconnected" },
        { name: "feishu", status: "connected" },
      ],
    },
    error: null,
  });

  it("parses pure acli channel status json", () => {
    expect(parseEnabledHermesChannels(channelStatusPayload)).toEqual(new Set(["weixin", "feishu"]));
  });

  it("normalizes wechat aliases to the weixin notification key", () => {
    const output = JSON.stringify({
      success: true,
      data: {
        platforms: [
          { name: "wechat", status: "connected" },
          { name: "openclaw-weixin", status: "connected" },
        ],
      },
      error: null,
    });

    expect(parseEnabledHermesChannels(output)).toEqual(new Set(["weixin"]));
  });

  it("normalizes international channel aliases to notification keys", () => {
    const output = JSON.stringify({
      success: true,
      data: {
        platforms: [
          { name: "openclaw-telegram", status: "connected" },
          { name: "whatsapp-business", status: "ready" },
          { name: "openclaw-discord", status: "enabled" },
          { name: "openclaw-wecom", status: "connected" },
          { name: "openclaw-lark", status: "running" },
          { name: "openclaw-qq", status: "connected" },
        ],
      },
      error: null,
    });

    expect(parseEnabledHermesChannels(output)).toEqual(new Set(["telegram", "whatsapp", "discord", "wecom", "feishu", "qqbot"]));
  });

  it("parses object-shaped channel status payloads", () => {
    const output = JSON.stringify({
      success: true,
      data: {
        channels: {
          "openclaw-telegram": { enabled: true },
          "openclaw-whatsapp": "connected",
          "openclaw-discord": false,
        },
      },
      error: null,
    });

    expect(parseEnabledHermesChannels(output)).toEqual(new Set(["telegram", "whatsapp"]));
  });
});

describe("isHermesNotificationChannelConfigured", () => {
  it("treats unknown channel status as configurable so users can still try", () => {
    expect(isHermesNotificationChannelConfigured(null, "feishu")).toBe(true);
  });

  it("uses the loaded enabled-channel set when channel status is known", () => {
    const enabledChannels = new Set(["weixin"]);

    expect(isHermesNotificationChannelConfigured(enabledChannels, "weixin")).toBe(true);
    expect(isHermesNotificationChannelConfigured(enabledChannels, "feishu")).toBe(false);
  });

  it("keeps coming-soon channels disabled even when status is unknown", () => {
    expect(isHermesNotificationChannelConfigured(null, "telegram", true)).toBe(false);
  });
});

describe("formatTestSendError", () => {
  it("wraps raw send failures in actionable Chinese copy", () => {
    expect(formatTestSendError(new Error("backend failed"), "发送失败，请检查通道配置或稍后重试"))
      .toBe("发送失败，请检查通道配置或稍后重试：backend failed");
  });

  it("translates common English command errors", () => {
    expect(formatTestSendError(new Error("Command timed out"), "发送失败，请检查通道配置或稍后重试"))
      .toBe("发送失败，请检查通道配置或稍后重试：命令执行超时");
    expect(formatTestSendError(new Error("Unknown platform: wechat"), "发送失败，请检查通道配置或稍后重试"))
      .toBe("发送失败，请检查通道配置或稍后重试：未知通知通道：wechat");
  });

  it("extracts the real stderr from debug exec failure summaries", () => {
    expect(formatTestSendError(
      new Error("status=FAILED exit_code=1 stderr=Unknown platform: telegram"),
      "发送失败，请检查通道配置或稍后重试",
    )).toBe("发送失败，请检查通道配置或稍后重试：未知通知通道：telegram");
  });

  it("formats common command errors in English when an English translator is provided", () => {
    const t = ((text: string, vars?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        "命令执行超时": "Command timed out",
        "未知通知通道：{{platform}}": "Unknown notification channel: {{platform}}",
        "实例内命令执行权限不足": "Insufficient permission to run commands in the instance",
      };
      const template = translations[text] ?? text;
      if (!vars) return template;
      return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => String(vars[key] ?? ""));
    });

    expect(formatTestSendError(
      new Error("Unknown platform: telegram"),
      "Failed to send. Please check the channel configuration or try again later.",
      t,
    )).toBe("Failed to send. Please check the channel configuration or try again later: Unknown notification channel: telegram");
  });

  it("hides low-level missing-command details from users", () => {
    expect(formatTestSendError(new Error("hermes: command not found"), "发送失败，请检查通道配置或稍后重试"))
      .toBe("发送失败，请检查通道配置或稍后重试");
  });
});

describe("getTestSendFailureFallback", () => {
  it("uses the more specific Weixin home-channel hint for weixin aliases", () => {
    expect(getTestSendFailureFallback("weixin", "通用失败", "微信失败")).toBe("微信失败");
    expect(getTestSendFailureFallback("wechat", "通用失败", "微信失败")).toBe("微信失败");
  });

  it("keeps the generic fallback for other platforms", () => {
    expect(getTestSendFailureFallback("feishu", "通用失败", "微信失败")).toBe("通用失败");
  });

  it("uses the more specific WeCom home-channel hint for wecom aliases when provided", () => {
    expect(getTestSendFailureFallback("wecom", "通用失败", "微信失败", "企微失败")).toBe("企微失败");
    expect(getTestSendFailureFallback("wework", "通用失败", "微信失败", "企微失败")).toBe("企微失败");
    expect(getTestSendFailureFallback("openclaw-wecom", "通用失败", "微信失败", "企微失败")).toBe("企微失败");
  });

  it("falls back to the generic message for wecom when no wecom-specific hint is provided", () => {
    expect(getTestSendFailureFallback("wecom", "通用失败", "微信失败")).toBe("通用失败");
  });
});

describe("cron date parsing and expiration filtering", () => {
  it("parses timezone-less cron dates as local time explicitly", () => {
    const parsed = parseCronDate("2026-05-26T09:00:00.471081");

    expect(parsed.getTime()).toBe(new Date(2026, 4, 26, 9, 0, 0, 471).getTime());
  });

  it("keeps explicit timezone cron dates on their absolute instant", () => {
    const parsed = parseCronDate("2026-05-26T09:00:00.471081+08:00");

    expect(parsed.getTime()).toBe(new Date("2026-05-26T09:00:00.471+08:00").getTime());
  });

  it("parses once display fallback as local display time", () => {
    const parsed = parseOnceScheduleDate("once at 2026-05-26 09:00", null);

    expect(parsed.getTime()).toBe(new Date(2026, 4, 26, 9, 0).getTime());
  });

  it("does not hide once jobs from display-only fallback dates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-26T10:05:00+08:00"));

    expect(isCronJobExpiredBeyondGrace(makeCronJob({ next_run_at: null }))).toBe(false);
    expect(isCronJobExpiredBeyondGrace(makeCronJob({ next_run_at: "2026-05-26T09:00:00+08:00" }))).toBe(true);
  });

  it("keeps recently expired once jobs visible during the grace window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-26T10:05:00+08:00"));

    expect(isCronJobExpiredBeyondGrace(makeCronJob({ next_run_at: "2026-05-26T09:56:00+08:00" }))).toBe(false);
    expect(isCronJobExpiredBeyondGrace(makeCronJob({ next_run_at: "2026-05-26T09:54:00+08:00" }))).toBe(true);
  });
});

describe("schedule labels", () => {
  const t = ((text: string, vars?: Record<string, unknown>) => {
    if (!vars) return text;
    return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => String(vars[key] ?? ""));
  }) as Parameters<typeof formatScheduleTooltip>[1];

  it("prefixes interval schedule hover labels with the schedule mode", () => {
    expect(formatScheduleTooltip(makeCronJob({
      schedule: { kind: "interval", expr: "every 1h", display: "every 1h" },
    }), t)).toBe("按间隔 · 每 1 小时");
  });

  it("prefixes recurring schedule hover labels with the schedule mode", () => {
    expect(formatScheduleTooltip(makeCronJob({
      schedule: { kind: "cron", expr: "51 10 * * *", display: "51 10 * * *" },
    }), t)).toBe("周期 · 每天 10:51");
  });

  it("formats LightVela daily time metadata as one recurring task label", () => {
    expect(formatScheduleTooltip(makeCronJob({
      schedule: { kind: "cron", expr: "* * * * *", display: "* * * * *" },
      lightvela_schedule: { kind: "daily_times", times: ["09:00", "12:30"] },
    }), t)).toBe("周期 · 每天 09:00、12:30");
  });

  it("keeps one-time schedule hover labels unchanged", () => {
    expect(formatScheduleTooltip(makeCronJob({
      schedule: { kind: "once", expr: "once at 2026-05-26 09:00", display: "once at 2026-05-26 09:00" },
    }), t)).toBe("单次 2026-05-26 09:00");
  });
});

describe("effective window helpers", () => {
  const now = new Date(2026, 5, 15, 9, 0).getTime();

  it("treats an empty effective window as always active", () => {
    expect(buildEffectiveWindowFromInputs("", "")).toBeNull();
    expect(getEffectiveWindowStatus(null, now)).toBe("always");
  });

  it("builds weekday-only gates for interval schedules", () => {
    expect(buildEffectiveWindowFromInputs("", "", [5, 6, 0])).toEqual({
      start_at: null,
      end_at: null,
      weekdays: [5, 6, 0],
    });
    expect(getEffectiveWindowStatus({ start_at: null, end_at: null, weekdays: [5, 6, 0] }, now)).toBe("active");
  });

  it("omits open-ended date placeholders for weekday-only labels", () => {
    const t = ((text: string) => text) as Parameters<typeof formatEffectiveWindow>[1];

    expect(formatEffectiveWindow({ start_at: null, end_at: null, weekdays: [5, 6, 0] }, t))
      .toBe("生效中 · 执行日：周五、周六、周日");
  });

  it("formats detail modal effective periods without repeating weekdays", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T12:30:00+08:00"));

    const t = ((text: string) => text) as Parameters<typeof formatEffectiveWindowPeriod>[1];

    expect(formatEffectiveWindowPeriod({
      start_at: "2026-06-08T08:00",
      end_at: "2026-06-08T11:02",
      weekdays: [2, 3, 4, 5, 6, 0],
    }, t)).toBe("2026-06-08 08:00 - 2026-06-08 11:02 · 已过生效期");

    expect(formatEffectiveWindowPeriod(null, t)).toBe("未配置（即始终生效）");
  });

  it("splits configured dates and weekdays across tooltip lines", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T09:00:00+08:00"));

    const t = ((text: string) => text) as Parameters<typeof formatEffectiveWindowTooltipLines>[1];

    expect(formatEffectiveWindowTooltipLines({
      start_at: "2026-06-08T08:00",
      end_at: "2026-06-08T11:02",
      weekdays: [2, 3, 4, 5, 6, 0],
    }, t)).toEqual([
      "执行日：周二、周三、周四、周五、周六、周日",
      "生效期：2026-06-08 08:00 - 2026-06-08 11:02 · 生效中",
    ]);
  });

  it("normalizes date-time values from either space or T separators", () => {
    expect(normalizeEffectiveWindowInput("2026-06-10 08:30")).toBe("2026-06-10T08:30");
    expect(normalizeEffectiveWindowInput("2026-06-10T08:30")).toBe("2026-06-10T08:30");
  });

  it("reports pending, active and ended windows without mutating the job", () => {
    expect(getEffectiveWindowStatus({ start_at: "2026-06-16T00:00", end_at: "2026-06-20T00:00" }, now)).toBe("pending");
    expect(getEffectiveWindowStatus({ start_at: "2026-06-10T00:00", end_at: "2026-06-20T00:00" }, now)).toBe("active");
    expect(getEffectiveWindowStatus({ start_at: "2026-06-10T00:00", end_at: "2026-06-14T23:59" }, now)).toBe("ended");
  });

  it("rejects an end time earlier than the start time", () => {
    expect(isEffectiveWindowRangeInvalid({
      start_at: "2026-06-20T00:00",
      end_at: "2026-06-10T00:00",
    })).toBe(true);
  });
});

describe("getLastAgentRunForJob", () => {
  it("uses the latest filtered Agent run instead of Hermes last_run_at", () => {
    const job = makeCronJob({
      id: "job-1",
      last_run_at: "2026-06-06T14:20:37+08:00",
      last_status: "ok",
    });
    const olderAgentRun = makeCronRun({
      job_id: "job-1",
      run_at: "2026-06-06T12:20:37+08:00",
    });
    const latestAgentRun = makeCronRun({
      job_id: "job-1",
      run_at: "2026-06-06T13:20:37+08:00",
    });

    expect(getLastAgentRunForJob(job, [olderAgentRun, latestAgentRun])?.run_at)
      .toBe("2026-06-06T13:20:37+08:00");
  });

  it("returns null when no confirmed Agent run is available for the job", () => {
    expect(getLastAgentRunForJob(makeCronJob({ id: "job-1" }), [
      makeCronRun({ job_id: "other-job" }),
    ])).toBeNull();
  });
});

describe("once schedule validation", () => {
  const now = new Date(2026, 4, 26, 10, 0).getTime();

  it("rejects creating a once task in the past", () => {
    expect(shouldRejectPastOnceSchedule(makeScheduleCheck({
      mode: "create",
      onceDate: "2026-05-26T09:59",
      schedule: "2026-05-26T09:59",
      now,
    }))).toBe(true);
  });

  it("allows editing an unchanged once task even if its time is already past", () => {
    expect(shouldRejectPastOnceSchedule(makeScheduleCheck({
      mode: "edit",
      onceDate: "2026-05-26T09:59",
      initialOnceDate: "2026-05-26T09:59",
      schedule: "2026-05-26T09:59",
      originalSchedule: "once at 2026-05-26 09:59",
      now,
    }))).toBe(false);
  });

  it("rejects editing a once task to an earlier past time", () => {
    expect(shouldRejectPastOnceSchedule(makeScheduleCheck({
      mode: "edit",
      onceDate: "2026-05-26T09:58",
      initialOnceDate: "2026-05-26T09:59",
      schedule: "2026-05-26T09:58",
      originalSchedule: "once at 2026-05-26 09:59",
      now,
    }))).toBe(true);
  });

  it("allows editing a once task to a future time", () => {
    expect(shouldRejectPastOnceSchedule(makeScheduleCheck({
      mode: "edit",
      onceDate: "2026-05-26T10:10",
      initialOnceDate: "2026-05-26T09:59",
      schedule: "2026-05-26T10:10",
      originalSchedule: "once at 2026-05-26 09:59",
      now,
    }))).toBe(false);
  });
});

function makeScheduleCheck(overrides: Partial<Parameters<typeof shouldRejectPastOnceSchedule>[0]>): Parameters<typeof shouldRejectPastOnceSchedule>[0] {
  return {
    mode: "edit",
    scheduleUneditable: false,
    kind: "once",
    onceDate: "2026-05-26T10:10",
    initialOnceDate: "2026-05-26T09:59",
    schedule: "2026-05-26T10:10",
    originalSchedule: "2026-05-26T09:59",
    now: new Date(2026, 4, 26, 10, 0).getTime(),
    ...overrides,
  };
}

function makeCronJob(overrides: Partial<CronJob>): CronJob {
  return {
    id: "job-1",
    name: "提醒",
    prompt: "提醒我喝水",
    schedule: { kind: "once", expr: "once at 2026-05-26 09:00", display: "once at 2026-05-26 09:00" },
    skills: [],
    enabled: true,
    state: "",
    deliver: "local",
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    created_at: null,
    script: "",
    effective_window: null,
    lightvela_schedule: null,
    ...overrides,
  };
}

function makeCronRun(overrides: Partial<CronRunRecord>): CronRunRecord {
  return {
    id: "run-1",
    job_id: "job-1",
    job_name: "提醒",
    job_prompt: "提醒我喝水",
    skills: [],
    schedule: { kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" },
    deliver: "local",
    run_at: "2026-06-06T09:00:00+08:00",
    status: "ok",
    output_path: "/home/agentuser/.hermes/cron/output/job-1/run.md",
    ...overrides,
  };
}
