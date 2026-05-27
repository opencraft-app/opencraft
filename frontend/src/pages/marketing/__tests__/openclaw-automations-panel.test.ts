import { describe, expect, it } from "vitest";

import {
  buildDeliverString,
  buildScheduleString,
  parseInitialDeliver,
  parseInitialSchedule,
  truncateCronJobCardTitle,
} from "../openclaw-automations-panel";

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
      weekday: 3,
      monthday: 1,
      intervalNum: 1,
      intervalUnit: "h",
      onceDate: "",
    }))).toMatchObject({ kind: "recurring", period: "weekly", time: "18:30", weekday: 3 });

    expect(parseInitialSchedule(buildScheduleString({
      kind: "recurring",
      period: "monthly",
      time: "07:00",
      weekday: 1,
      monthday: 28,
      intervalNum: 1,
      intervalUnit: "h",
      onceDate: "",
    }))).toMatchObject({ kind: "recurring", period: "monthly", time: "07:00", monthday: 28 });
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
    expect(parseInitialSchedule("0 9 * * 1,3,5")).toBeNull();
    expect(parseInitialSchedule("0 9-18 * * *")).toBeNull();
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

describe("truncateCronJobCardTitle", () => {
  it("keeps short Chinese and English titles unchanged", () => {
    expect(truncateCronJobCardTitle("喝水提醒")).toBe("喝水提醒");
    expect(truncateCronJobCardTitle("drink water")).toBe("drink water");
  });

  it("limits Chinese titles to about eight characters", () => {
    expect(truncateCronJobCardTitle("这是一个很长很长的提醒")).toBe("这是一个很长很长…");
  });

  it("limits English titles to twelve characters", () => {
    expect(truncateCronJobCardTitle("abcdefghijklmn")).toBe("abcdefghijkl…");
  });
});
