import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildEffectiveWindowFromInputs,
  buildDeliverString,
  buildScheduleString,
  getLastAgentRunForJob,
  getEffectiveWindowStatus,
  isCronJobExpiredBeyondGrace,
  isEffectiveWindowRangeInvalid,
  normalizeEffectiveWindowInput,
  parseCronDate,
  parseInitialDeliver,
  parseInitialSchedule,
  parseOnceScheduleDate,
  shouldRejectPastOnceSchedule,
} from "../openclaw-automations-panel";
import type { CronJob, CronRunRecord } from "@/lib/hermes-cron-client";

afterEach(() => {
  vi.useRealTimers();
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
    ...overrides,
  };
}

function makeCronRun(overrides: Partial<CronRunRecord>): CronRunRecord {
  return {
    id: "run-1",
    job_id: "job-1",
    job_name: "提醒",
    job_prompt: "提醒我喝水",
    schedule: { kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" },
    deliver: "local",
    run_at: "2026-06-06T09:00:00+08:00",
    status: "ok",
    output_path: "/home/agentuser/.hermes/cron/output/job-1/run.md",
    ...overrides,
  };
}
