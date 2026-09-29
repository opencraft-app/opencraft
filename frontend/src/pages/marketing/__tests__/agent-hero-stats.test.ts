import { describe, expect, it } from "vitest";

import { computeServedDays, formatExpiryDate } from "@/pages/marketing/agent-hero-stats";

describe("computeServedDays", () => {
  const now = new Date("2026-09-14T12:00:00Z").getTime();

  it("counts the first day as 1 instead of 0", () => {
    // 当天订阅不该显示「已服务 0 天」
    expect(computeServedDays("2026-09-14T09:00:00Z", now)).toBe(1);
  });

  it("counts elapsed days inclusively", () => {
    expect(computeServedDays("2026-09-12T09:00:00Z", now)).toBe(3);
  });

  it("returns null when the timestamp is missing or unparsable", () => {
    expect(computeServedDays(undefined, now)).toBeNull();
    expect(computeServedDays("not a date", now)).toBeNull();
  });
});

describe("formatExpiryDate", () => {
  it("formats a localized date", () => {
    const formatted = formatExpiryDate("2026-09-12T00:00:00Z", "zh-CN");
    expect(formatted).toContain("2026");
    expect(formatted).toContain("9");
  });

  it("returns null for missing or invalid input", () => {
    expect(formatExpiryDate(undefined)).toBeNull();
    expect(formatExpiryDate("garbage")).toBeNull();
  });
});
