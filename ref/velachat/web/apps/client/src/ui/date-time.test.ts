import {
  formatConversationTimestamp,
  formatReadableDateTime,
} from "./date-time";

describe("formatReadableDateTime", () => {
  it("turns a wire timestamp into a concise Chinese local time", () => {
    expect(
      formatReadableDateTime(
        "2026-08-02T02:31:00.000Z",
        "Asia/Shanghai",
      ),
    ).toBe("2026年8月2日 10:31");
  });

  it("does not pretend an invalid timestamp was formatted", () => {
    expect(formatReadableDateTime("not-a-time", "Asia/Shanghai")).toBe(
      "时间未知",
    );
  });
});

describe("formatConversationTimestamp", () => {
  const now = new Date("2026-08-02T04:00:00.000Z");

  it.each([
    ["2026-08-02T02:25:00.000Z", "10:25"],
    ["2026-08-01T08:00:00.000Z", "昨天"],
    ["2026-07-31T08:00:00.000Z", "7/31"],
    ["2025-12-31T08:00:00.000Z", "2025/12/31"],
  ])("formats %s for a compact conversation row", (value, expected) => {
    expect(
      formatConversationTimestamp(value, now, "Asia/Shanghai"),
    ).toBe(expected);
  });

  it("does not render a misleading time for invalid input", () => {
    expect(
      formatConversationTimestamp("not-a-time", now, "Asia/Shanghai"),
    ).toBe("");
  });

  it("reuses timezone formatters across message rows", () => {
    const formatter = jest.spyOn(Intl, "DateTimeFormat");
    try {
      formatConversationTimestamp(
        "2026-08-02T02:25:00.000Z",
        now,
        "Pacific/Honolulu",
      );
      formatConversationTimestamp(
        "2026-08-02T02:26:00.000Z",
        now,
        "Pacific/Honolulu",
      );

      expect(formatter).toHaveBeenCalledTimes(1);
    } finally {
      formatter.mockRestore();
    }
  });
});
