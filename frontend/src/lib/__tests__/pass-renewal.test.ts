import { describe, expect, it } from "vitest";

import type { Pass } from "@/domain/types";
import { getPassExpiryReminder, RENEWAL_PERIOD_OPTIONS } from "@/lib/pass-renewal";

const buildPass = (expiredTime: string): Pass => ({
  pass_id: "pass_renewal_boundary",
  user_id: "usr_renewal_boundary",
  bundle_id: "bundle_launch",
  bundle_name: "启航套餐",
  created_time: "2026-07-01T00:00:00.000Z",
  expired_time: expiredTime,
  isolated_time: null,
  deleted_time: null,
  credit_total: 1000,
  credit_available: 800,
});

describe("pass renewal helpers", () => {
  it("only exposes monthly and quarterly renewal options", () => {
    expect(RENEWAL_PERIOD_OPTIONS.map((option) => option.label)).toEqual(["月付", "季付"]);
    expect(RENEWAL_PERIOD_OPTIONS.map((option) => option.period)).toEqual([1, 3]);
  });

  it("builds a day-level reminder within seven days", () => {
    const reminder = getPassExpiryReminder(
      buildPass("2026-07-07T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z").getTime(),
    );

    expect(reminder).toMatchObject({
      label: "临近到期",
      tooltip: "剩余 6 天到期",
      level: "warning",
    });
  });

  it("builds an hour-level urgent reminder inside one day", () => {
    const reminder = getPassExpiryReminder(
      buildPass("2026-07-01T18:00:00.000Z"),
      new Date("2026-07-01T12:30:00.000Z").getTime(),
    );

    expect(reminder).toMatchObject({
      label: "即将到期",
      tooltip: "剩余 6 小时到期",
      level: "urgent",
    });
  });

  it("does not show reminders outside the seven-day window", () => {
    expect(getPassExpiryReminder(
      buildPass("2026-07-09T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z").getTime(),
    )).toBeNull();
  });
});
