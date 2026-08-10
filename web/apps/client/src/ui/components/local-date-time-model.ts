import {
  CalendarDate,
  CalendarDateTime,
  fromAbsolute,
  parseDateTime,
  Time,
} from "@internationalized/date";

export type DateTimeRounding = "ceil" | "floor" | "nearest";

export function parseLocalDateTimeValue(
  value: string | undefined,
): CalendarDateTime | null {
  if (!value) return null;
  try {
    const parsed = parseDateTime(value.trim());
    return new CalendarDateTime(
      parsed.year,
      parsed.month,
      parsed.day,
      parsed.hour,
      parsed.minute,
    );
  } catch {
    return null;
  }
}

export function serializeLocalDateTimeValue(value: CalendarDateTime): string {
  return [
    String(value.year).padStart(4, "0"),
    String(value.month).padStart(2, "0"),
    String(value.day).padStart(2, "0"),
  ].join("-") + `T${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;
}

export function formatDateTimeDisplay(value: CalendarDateTime): string {
  return `${String(value.year).padStart(4, "0")}/${String(value.month).padStart(2, "0")}/${String(value.day).padStart(2, "0")} ${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;
}

export function formatInstantAsLocalDateTime(
  instant: Date,
  timezone: string,
  minuteStep = 1,
  rounding: DateTimeRounding = "floor",
): string {
  const step = normalizedMinuteStep(minuteStep);
  const stepMilliseconds = step * 60_000;
  const quotient = instant.getTime() / stepMilliseconds;
  const rounded = rounding === "ceil"
    ? Math.ceil(quotient)
    : rounding === "nearest"
      ? Math.round(quotient)
      : Math.floor(quotient);
  const local = fromAbsolute(rounded * stepMilliseconds, timezone);
  return serializeLocalDateTimeValue(new CalendarDateTime(
    local.year,
    local.month,
    local.day,
    local.hour,
    local.minute,
  ));
}

export function replaceDate(
  value: CalendarDateTime,
  date: CalendarDate,
): CalendarDateTime {
  return new CalendarDateTime(
    date.year,
    date.month,
    date.day,
    value.hour,
    value.minute,
  );
}

export function replaceTime(
  value: CalendarDateTime,
  time: Time,
): CalendarDateTime {
  return new CalendarDateTime(
    value.year,
    value.month,
    value.day,
    time.hour,
    time.minute,
  );
}

export function clampCalendarDateTime(
  value: CalendarDateTime,
  minValue: CalendarDateTime | null,
  maxValue: CalendarDateTime | null,
): CalendarDateTime {
  if (minValue && value.compare(minValue) < 0) return minValue;
  if (maxValue && value.compare(maxValue) > 0) return maxValue;
  return value;
}

export function normalizedMinuteStep(value: number | undefined): number {
  if (!Number.isInteger(value) || !value || value < 1 || value > 60) return 1;
  return value;
}
