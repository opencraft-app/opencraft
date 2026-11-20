const DAY = 86400000;

/** Owns persisted engagement signals and guard state, not schedules or delivery. */
export class AttentionService {
  constructor({ repository, uow, notice, inbox, now = Date.now }) {
    Object.assign(this, { repository, uow, notice, inbox, now });
    repository.ensure(now());
  }
  status() {
    return this.repository.get();
  }
  active(viewed = false) {
    this.uow.transaction(() => {
      const s = this.status();
      this.repository.save({
        ...s,
        last_active_at: this.now(),
        last_viewed_at: viewed ? this.now() : s.last_viewed_at,
        unread_count: viewed ? 0 : s.unread_count,
        fire_count: 0,
        nudged_at: null,
        paused_at: null,
      });
    });
  }
  fired() {
    const s = this.status();
    this.repository.save({ ...s, fire_count: s.fire_count + 1 });
  }
  notified() {
    const s = this.status();
    this.repository.save({ ...s, unread_count: s.unread_count + 1 });
  }
  snooze(inputId, params) {
    if (
      !Number.isSafeInteger(params.durationMs) ||
      params.durationMs < 1000 ||
      params.durationMs > 30 * DAY
    )
      throw new Error("Snooze duration must be 1000ms..30days");
    return this.inbox.accept(inputId, "attention.snooze", params, () => {
      const until = this.now() + params.durationMs;
      this.repository.save({ ...this.status(), snoozed_until: until });
      return { snoozedUntil: until };
    });
  }
  assess() {
    const s = this.status(),
      now = this.now();
    if (
      s.paused_at !== null ||
      now < s.snoozed_until ||
      now - s.last_active_at < 3 * DAY
    )
      return "none";
    if (s.nudged_at !== null) {
      if (now - s.nudged_at < 3 * DAY) return "none";
      this.repository.save({ ...s, paused_at: now });
      this.notice(
        `guard-paused:${now}`,
        "例行任务持续运行但近期没有你的活动，已暂停后续安排。可以用 routine-resume 恢复。",
        { kind: "routine-guard-paused" },
      );
      return "pause";
    }
    if (s.unread_count < 15 && s.fire_count < 20) return "none";
    this.repository.save({ ...s, nudged_at: now });
    this.notice(
      `guard-nudge:${now}`,
      "你近期没有查看助理，例行任务仍在持续运行。若继续没有活动，三天后会暂停；可查看会话、暂缓检查或恢复所需安排。",
      { kind: "routine-guard-nudge" },
    );
    return "nudge";
  }
}
