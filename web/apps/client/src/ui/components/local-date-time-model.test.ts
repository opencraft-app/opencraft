import {CalendarDate, CalendarDateTime, Time} from "@internationalized/date";

import {
  clampCalendarDateTime,
  formatDateTimeDisplay,
  formatInstantAsLocalDateTime,
  parseLocalDateTimeValue,
  replaceDate,
  replaceTime,
  serializeLocalDateTimeValue,
} from "./local-date-time-model";

describe("local date time model", () => {
  it("parses and serializes minute-precision wall clock values", () => {
    const value = parseLocalDateTimeValue("2024-02-29T23:55");

    expect(value).toEqual(new CalendarDateTime(2024, 2, 29, 23, 55));
    expect(serializeLocalDateTimeValue(value!)).toBe("2024-02-29T23:55");
    expect(parseLocalDateTimeValue("2023-02-29T23:55")).toBeNull();
    expect(parseLocalDateTimeValue("not-a-date")).toBeNull();
  });

  it("formats an instant in the requested timezone before rounding", () => {
    const instant = new Date("2026-08-10T01:02:30.000Z");

    expect(formatInstantAsLocalDateTime(instant, "Asia/Shanghai", 5, "floor"))
      .toBe("2026-08-10T09:00");
    expect(formatInstantAsLocalDateTime(instant, "Asia/Shanghai", 5, "ceil"))
      .toBe("2026-08-10T09:05");
  });

  it("combines calendar and time edits without leaking seconds", () => {
    const value = new CalendarDateTime(2026, 8, 10, 9, 35, 42);

    expect(replaceDate(value, new CalendarDate(2026, 9, 2)))
      .toEqual(new CalendarDateTime(2026, 9, 2, 9, 35));
    expect(replaceTime(value, new Time(18, 5, 59)))
      .toEqual(new CalendarDateTime(2026, 8, 10, 18, 5));
  });

  it("clamps values to the configured local bounds", () => {
    const min = new CalendarDateTime(2026, 8, 10, 9, 10);
    const max = new CalendarDateTime(2026, 9, 9, 9, 0);

    expect(clampCalendarDateTime(new CalendarDateTime(2026, 8, 10, 9, 5), min, max))
      .toEqual(min);
    expect(clampCalendarDateTime(new CalendarDateTime(2026, 9, 10, 9, 0), min, max))
      .toEqual(max);
    expect(clampCalendarDateTime(new CalendarDateTime(2026, 8, 17, 9, 0), min, max))
      .toEqual(new CalendarDateTime(2026, 8, 17, 9, 0));
  });

  it("formats the field value without relying on the browser datetime control", () => {
    expect(formatDateTimeDisplay(new CalendarDateTime(2026, 8, 7, 9, 5)))
      .toBe("2026/08/07 09:05");
  });
});
