/** Calendar rules belong to the Host; clients only preview the same calculation. */
export interface ScheduleCalendar {
  period: "daily" | "weekly" | "monthly";
  times: string[];
  days: number[];
}
export interface ScheduleWindow { startAt: number | null; endAt: number | null; weekdays: number[]; }

export function validScheduleCalendar(value: unknown): value is ScheduleCalendar {
  if (!value || typeof value !== "object") return false;
  const c = value as ScheduleCalendar;
  return ["daily", "weekly", "monthly"].includes(c.period)
    && Array.isArray(c.times) && c.times.length > 0 && c.times.length <= 24
    && c.times.every(t => typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t))
    && Array.isArray(c.days) && c.days.length <= 31
    && (c.period === "daily" || c.days.length > 0)
    && c.days.every(d => Number.isInteger(d) && d >= (c.period === "monthly" ? 1 : 0) && d <= (c.period === "monthly" ? 31 : 6));
}
export function validScheduleWindow(value: unknown): value is ScheduleWindow {
  if (!value || typeof value !== "object") return false;
  const w = value as ScheduleWindow;
  return (w.startAt === null || Number.isSafeInteger(w.startAt)) && (w.endAt === null || Number.isSafeInteger(w.endAt))
    && (w.startAt === null || w.endAt === null || w.startAt < w.endAt)
    && Array.isArray(w.weekdays) && w.weekdays.length > 0 && w.weekdays.length <= 7
    && w.weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6);
}
function parts(format: Intl.DateTimeFormat, stamp: number) {
  return Object.fromEntries(format.formatToParts(stamp).map(p => [p.type, p.value]));
}
/** At most 370 calendar days; missing month days and DST gaps are skipped.
 * Ambiguous wall times execute once: the earliest matching instant for that date. */
export function nextCalendarRun(calendar: ScheduleCalendar, zone: string, after: number, scheduleWindow?: ScheduleWindow | null): number | null {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const start = Math.max(after, scheduleWindow?.startAt ?? after);
  const local = parts(format, start);
  const first = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day));
  const times = [...new Set(calendar.times)].sort();
  for (let day = 0; day <= 370; day++) {
    const date = new Date(first + day * 86400000), weekday = date.getUTCDay();
    if (calendar.period === "weekly" && !calendar.days.includes(weekday) || calendar.period === "monthly" && !calendar.days.includes(date.getUTCDate()) || scheduleWindow && !scheduleWindow.weekdays.includes(weekday)) continue;
    for (const time of times) {
      const [hour, minute] = time.split(":").map(Number);
      const target = date.getTime() + hour! * 3600000 + minute! * 60000;
      const candidates: number[] = [];
      // Offsets on both sides of a transition, including half-hour zones.
      for (const delta of [-86400000, 0, 86400000]) {
        const p = parts(format, target + delta);
        const offset = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!) - (target + delta);
        const candidate = target - offset, actual = parts(format, candidate);
        if (+actual.year! === date.getUTCFullYear() && +actual.month! === date.getUTCMonth() + 1 && +actual.day! === date.getUTCDate() && `${actual.hour}:${actual.minute}` === time) candidates.push(candidate);
      }
      if (!candidates.length) continue;
      const candidate = Math.min(...candidates);
      if (candidate >= start && (scheduleWindow?.endAt == null || candidate < scheduleWindow.endAt)) return candidate;
    }
  }
  return null;
}

export function nextIntervalRun(anchor: number, intervalMinutes: number, zone: string, after: number, scheduleWindow?: ScheduleWindow | null): number | null {
  const step = intervalMinutes * 60000, start = Math.max(after, scheduleWindow?.startAt ?? after);
  let candidate = anchor + Math.max(0, Math.ceil((start - anchor) / step)) * step;
  if (!scheduleWindow) return candidate;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" });
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let i = 0; i < 10081; i++, candidate += step) {
    if (scheduleWindow.endAt !== null && candidate >= scheduleWindow.endAt) return null;
    if (scheduleWindow.weekdays.includes(days.indexOf(formatter.format(candidate)))) return candidate;
  }
  return null;
}
