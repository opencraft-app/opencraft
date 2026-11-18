import { CalendarSchedule } from "./calendar-schedule.mjs";
import { epochTime, requireText } from "./values.mjs";

export class Routine {
  constructor(record) {
    this.record = { ...record };
  }
  static validate(params) {
    requireText(params.text, "text");
    if (params.schedule !== undefined) {
      CalendarSchedule.normalize(params.schedule);
      if (params.intervalMs !== undefined)
        throw new Error("Choose interval or calendar, not both");
      if (params.startAt !== undefined) epochTime(params.startAt, "startAt");
    } else {
      epochTime(params.startAt, "startAt");
      if (!Number.isSafeInteger(params.intervalMs) || params.intervalMs < 250)
        throw new Error("intervalMs must be >=250");
    }
    if (params.expiresAt !== undefined) {
      epochTime(params.expiresAt, "expiresAt");
      if (params.startAt !== undefined && params.expiresAt <= params.startAt)
        throw new Error("expiresAt must follow startAt");
    }
    if (
      params.maxRuns !== undefined &&
      (!Number.isSafeInteger(params.maxRuns) || params.maxRuns < 1)
    )
      throw new Error("maxRuns must be positive");
    if (params.stopWhen !== undefined) {
      requireText(params.stopWhen, "stopWhen", 2000);
      if (
        params.expiresAt === undefined &&
        params.maxRuns === undefined &&
        params.schedule?.kind !== "once"
      )
        throw new Error("A conditional watch needs expiresAt or maxRuns");
    }
  }
  assertOccurrence(revision, now) {
    const r = this.record;
    if (
      r.revision !== revision ||
      !["active", "exhausted"].includes(r.status) ||
      (r.expires_at !== null && r.expires_at <= now)
    )
      throw new Error("Routine no longer permits this occurrence");
  }
  due(now, hasActiveWork) {
    const r = this.record;
    if (r.status !== "active") return "skip";
    if (r.expires_at !== null && r.expires_at <= now) return "expire";
    return r.next_at <= now && !hasActiveWork ? "trigger" : "skip";
  }
  triggered(now) {
    const r = this.record,
      count = r.created_count + 1;
    const next = r.schedule_json
      ? CalendarSchedule.next(JSON.parse(r.schedule_json), now, r.next_at)
      : now + r.interval_ms;
    return {
      ...r,
      next_at: next ?? r.next_at,
      last_scheduled_at: r.next_at,
      created_count: count,
      status:
        next === null || (r.max_runs !== null && count >= r.max_runs)
          ? "exhausted"
          : "active",
    };
  }
}
