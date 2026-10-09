const localPartsFormatters = new Map<string, Intl.DateTimeFormat>();
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();
const readableFormatters = new Map<string, Intl.DateTimeFormat>();
let resolvedDeviceTimezone: string | null = null;

export function deviceTimezone(): string {
  if (resolvedDeviceTimezone) return resolvedDeviceTimezone;
  try {
    resolvedDeviceTimezone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    resolvedDeviceTimezone = "Asia/Shanghai";
  }
  return resolvedDeviceTimezone;
}

export function formatReadableDateTime(
  value: string,
  timezone = deviceTimezone(),
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";

  try {
    let formatter = readableFormatters.get(timezone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("zh-CN", {
        day: "numeric",
        hour: "2-digit",
        hourCycle: "h23",
        minute: "2-digit",
        month: "numeric",
        timeZone: timezone,
        year: "numeric",
      });
      readableFormatters.set(timezone, formatter);
    }
    const parts = formatter.formatToParts(date);
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    if (
      !values.year ||
      !values.month ||
      !values.day ||
      !values.hour ||
      !values.minute
    ) {
      return "时间未知";
    }
    return `${Number(values.year)}年${Number(values.month)}月${Number(values.day)}日 ${values.hour.padStart(2, "0")}:${values.minute.padStart(2, "0")}`;
  } catch {
    return "时间未知";
  }
}

export function formatConversationTimestamp(
  value: string,
  now = new Date(),
  timezone = deviceTimezone(),
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || Number.isNaN(now.getTime())) return "";

  try {
    const message = localDateParts(date, timezone);
    const current = localDateParts(now, timezone);
    const dayDifference = Math.round(
      (Date.UTC(current.year, current.month - 1, current.day) -
        Date.UTC(message.year, message.month - 1, message.day)) /
        86_400_000,
    );

    if (dayDifference === 0) {
      return `${String(message.hour).padStart(2, "0")}:${String(message.minute).padStart(2, "0")}`;
    }
    if (dayDifference === 1) return "昨天";
    if (message.year === current.year) {
      return `${message.month}/${message.day}`;
    }
    return `${message.year}/${message.month}/${message.day}`;
  } catch {
    return "";
  }
}

export function normalizeLocalDateTime(
  value: string,
  timezone: string,
): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    return trimmed;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(trimmed);
  if (!match) return trimmed;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (
    month < 1 || month > 12 || day < 1 || day > 31 ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59
  ) {
    return trimmed;
  }
  const wallClockAsUtc = new Date(Date.UTC(year, month - 1, day, hour, minute));
  let offsetMinutes: number;
  try {
    const firstOffset = timezoneOffsetMinutes(wallClockAsUtc, timezone.trim());
    const candidate = new Date(wallClockAsUtc.getTime() - firstOffset * 60_000);
    offsetMinutes = timezoneOffsetMinutes(candidate, timezone.trim());
  } catch {
    offsetMinutes = -new Date(year, month - 1, day, hour, minute).getTimezoneOffset();
  }
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0");
  const offsetRemainder = String(absoluteMinutes % 60).padStart(2, "0");
  return `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:00${sign}${offsetHours}:${offsetRemainder}`;
}

function timezoneOffsetMinutes(date: Date, timezone: string): number {
  let formatter = offsetFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: timezone,
      year: "numeric",
    });
    offsetFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const renderedAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return Math.round((renderedAsUtc - date.getTime()) / 60_000);
}

function localDateParts(date: Date, timezone: string) {
  let formatter = localPartsFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      timeZone: timezone,
      year: "numeric",
    });
    localPartsFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    month: Number(values.month),
    year: Number(values.year),
  };
}
