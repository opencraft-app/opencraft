import { epochTime } from "./values.mjs";

/** Explicit local wall-clock recurrence. Never guesses the process/user timezone. */
export class CalendarSchedule {
  static normalize(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Invalid schedule");
    if (raw.kind === "once") {
      if (Object.keys(raw).some((k) => !["kind", "at"].includes(k)))
        throw new Error("Unknown one-shot schedule field");
      epochTime(raw.at, "schedule.at");
      return { kind: "once", at: raw.at };
    }
    if (
      raw.kind !== "calendar" ||
      Object.keys(raw).some(
        (k) =>
          !["kind", "timeZone", "weekdays", "hours", "minutes"].includes(k),
      )
    )
      throw new Error("Use an explicit calendar or once schedule");
    if (typeof raw.timeZone !== "string" || raw.timeZone.length > 100)
      throw new Error("Calendar timezone is required");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: raw.timeZone });
    } catch {
      throw new Error("Unknown calendar timezone");
    }
    const normalized = { kind: "calendar", timeZone: raw.timeZone };
    for (const [key, max, fallback] of [
      ["weekdays", 6, [0, 1, 2, 3, 4, 5, 6]],
      ["hours", 23, null],
      ["minutes", 59, null],
    ]) {
      const values = raw[key] ?? fallback;
      if (
        !Array.isArray(values) ||
        !values.length ||
        values.length > max + 1 ||
        values.some((n) => !Number.isInteger(n) || n < 0 || n > max)
      )
        throw new Error(`Invalid calendar ${key}`);
      normalized[key] = [...new Set(values)].sort((a, b) => a - b);
    }
    return normalized;
  }
  static formatter(timeZone) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
  }
  static wall(formatter, at) {
    return Object.fromEntries(
      formatter
        .formatToParts(at)
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, p.value]),
    );
  }
  static next(raw, after, lastAt = null) {
    const s = this.normalize(raw);
    epochTime(after, "schedule anchor");
    if (s.kind === "once") return s.at > after ? s.at : null;
    const formatter = this.formatter(s.timeZone);
    const key = (p) => `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
    const last = lastAt === null ? null : key(this.wall(formatter, lastAt));
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    // At least one weekday is allowed: eight days covers a week and DST transitions.
    const end = after + 8 * 86400000;
    for (
      let at = Math.floor(after / 60000) * 60000 + 60000;
      at <= end;
      at += 60000
    ) {
      const wall = this.wall(formatter, at);
      if (
        s.weekdays.includes(days.indexOf(wall.weekday)) &&
        s.hours.includes(Number(wall.hour)) &&
        s.minutes.includes(Number(wall.minute)) &&
        key(wall) !== last
      )
        return at;
    }
    throw new Error("Calendar has no occurrence within eight days");
  }
}
