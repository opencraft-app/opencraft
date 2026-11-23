import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ScopedSqlDatabase } from "@opencraft/sql";
import { openManagedDatabase, createSchemaValidator, nodeSqlDatabase, type DatabaseOutcome } from "@opencraft/sqlite-node";
import type { ConversationSchedule, ConversationScheduleRun, ConversationScheduleView, ConversationScheduleSummary, OpenCraftPermissionProfile } from "@opencraft/appserver-protocol";
import { nextCalendarRun, nextIntervalRun, validScheduleCalendar, validScheduleWindow } from "@opencraft/appserver-protocol";
import { boundedWakeTimer, timeoutWakeClock, type OwnerWakeTimer, type OwnerWakeTimerFactory } from "@opencraft/workspace-host";

/** Engine boundary: a stable occurrence ID must survive retries and Host restarts.
 * submit must not steer. An ambiguous acceptance must return unknown, never throw
 * a retryable error after it might have reached the engine. */
export interface ScheduleExecutionEvent { threadId: string; turnId: string; state: "completed" | "failed" }
export interface ScheduleExecutionPort {
  subscribe?(listener: (event: ScheduleExecutionEvent) => void): () => void;
  validate(threadId: string): Promise<void>;
  permissionProfiles?(threadId: string): Promise<OpenCraftPermissionProfile[]>;
  submit(run: ConversationScheduleRun, prompt: string, canAdmit: () => boolean): Promise<{ state: "waiting" | "running" | "completed" | "failed" | "unknown"; turnId?: string }>;
  inspect(run: ConversationScheduleRun): Promise<{ state: "running" | "completed" | "failed" | "unknown"; turnId?: string }>;
}
const schema = `
CREATE TABLE schedules (thread_id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE schedule_runs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, value TEXT NOT NULL) STRICT;
CREATE INDEX schedule_runs_thread ON schedule_runs(thread_id);
`;
/** Published chain (`host-schedules`); the SQL text is checksummed and must never change. */
export const CONVERSATION_SCHEDULE_MIGRATIONS = [{ version: 1, name: "conversation-schedules", sql: schema }] as const;
const unfinished = new Set(["waiting", "submitting", "running", "unknown"]);
const MAX_FLIGHTS = 4;
/** While the owner's admission is fenced nothing announces its reopening except start(); due work re-checks at the
 * old polling cadence until then. Nothing re-checks while no work is due. */
const FENCED_RECHECK_MS = 2000;
export class ScheduleFault extends Error { constructor(readonly code: number, message: string) { super(message); } }
function fault(): never { throw new ScheduleFault(-32602, "Invalid schedule command"); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
/**
 * One writer per Host, guarded by the Host's existing writer lease. No browser lifetime.
 *
 * Owner-driven wake-up (workspace-host-split.md §4.3): after start(), every committed plan change and every settled
 * pass computes the earliest due time from durable state (plus the in-memory retry back-off) and arms the single
 * owner wake-up. The wake-up only triggers a pass; whether anything is due is decided from durable state at that
 * moment, so a stale or early wake-up dispatches nothing. start() first catches up whatever durable state already
 * shows as due or unfinished.
 */
/** Runtime-neutral domain over the SQL port. The opening owner (Node file below, or a Durable Object's SQL) lends
 * the migrated connection; `close()` ends this store's lease after in-flight work settles. */
export class SqlConversationSchedules {
  private readonly storage: ScopedSqlDatabase;
  private readonly timer: OwnerWakeTimer;
  private started = false;
  private readonly pending = new Set<Promise<void>>();
  private readonly flights = new Map<string, Promise<void>>();
  private stopped = false;
  private closing: Promise<void> | null = null;
  private inTransaction = false;
  private summarySignature = "";
  // Check scheduling is ephemeral and scoped to the conversation flight, even
  // before an occurrence can be persisted. Native events cannot waive a failure.
  private readonly retries = new Map<string, { at: number; failed: boolean }>();
  // Only unfinished occurrences can retain an early native completion, including
  // completion racing the submit acknowledgement. This is not an execution log.
  private readonly observations = new Map<string, ScheduleExecutionEvent>();
  private readonly unsubscribe: (() => void) | undefined;

  constructor(storage: ScopedSqlDatabase, private readonly port: ScheduleExecutionPort,
    private readonly now = Date.now, private readonly diagnostic: (event: { event: string; scheduleId?: string }) => void = () => {},
    private readonly changed: () => void = () => {},
    private readonly admissionOpen: () => boolean = () => true,
    wakeTimer: OwnerWakeTimerFactory = wake => boundedWakeTimer(timeoutWakeClock(now), wake)) {
    this.storage = storage;
    this.summarySignature = JSON.stringify(this.list());
    this.unsubscribe = port.subscribe?.(event => this.executionChanged(event));
    this.timer = wakeTimer(() => { void this.tick(); });
  }
  private get db() { return this.storage.database; }
  private plans(): ConversationSchedule[] {
    return this.db.prepare("SELECT value FROM schedules").all().map(row => JSON.parse(String(row.value)) as ConversationSchedule);
  }
  private schedule(threadId: string): ConversationSchedule | null {
    const row = this.db.prepare("SELECT value FROM schedules WHERE thread_id=?").get(threadId);
    return row ? JSON.parse(String(row.value)) : null;
  }
  private runs(threadId: string): ConversationScheduleRun[] {
    return this.db.prepare("SELECT value FROM schedule_runs WHERE thread_id=? ORDER BY rowid DESC LIMIT 30").all(threadId)
      .map(row => JSON.parse(String(row.value)) as ConversationScheduleRun);
  }
  private writeSchedule(value: ConversationSchedule) {
    this.db.prepare("INSERT INTO schedules VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET value=excluded.value").run(value.threadId, JSON.stringify(value));
    this.publishChanged();
  }
  private writeRun(value: ConversationScheduleRun) {
    this.db.prepare("INSERT INTO schedule_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(value.id, value.threadId, JSON.stringify(value));
    this.publishChanged();
  }
  private transaction<T>(fn: () => T): T {
    this.inTransaction = true;
    let result: T;
    try { result = this.db.transaction(fn); }
    finally { this.inTransaction = false; }
    this.publishChanged(); return result;
  }
  /** Public catalog projection: no prompts, creator identities or execution history. */
  list(): { schedules: ConversationScheduleSummary[] } {
    const rows = this.db.prepare(`SELECT s.value,
      EXISTS(SELECT 1 FROM schedule_runs r WHERE r.thread_id=s.thread_id AND json_extract(r.value,'$.state')='unknown') AS needs_review
      FROM schedules s ORDER BY s.thread_id`).all();
    return { schedules: rows.flatMap(row => {
      const plan = JSON.parse(String(row.value)) as ConversationSchedule;
      const needsReview = Boolean(row.needs_review);
      return plan.status === "active" || plan.status === "paused" || needsReview
        ? [{ threadId: plan.threadId, status: plan.status, nextRunAt: plan.nextRunAt, needsReview }] : [];
    }) };
  }
  private publishChanged() {
    if (this.inTransaction) return;
    const signature = JSON.stringify(this.list());
    if (signature === this.summarySignature) return;
    this.summarySignature = signature;
    try { this.changed(); } catch { /* A notification observer cannot roll back committed state. */ }
  }
  read(threadId: string): ConversationScheduleView { return { schedule: this.schedule(threadId), runs: this.runs(threadId) }; }
  /** Occurrence policy survives queue recovery and later plan edits. */
  executionPermissions(threadId: string, occurrenceId: string): string | null {
    const row = this.db.prepare("SELECT value FROM schedule_runs WHERE thread_id=? AND id=?").get(threadId, occurrenceId);
    return row ? (JSON.parse(String(row.value)) as ConversationScheduleRun).permissions ?? null : null;
  }
  async handle(method: string, input: unknown, createdBy: string | null): Promise<ConversationScheduleView> {
    const p = object(input), threadId = p.threadId;
    if (typeof threadId !== "string" || !threadId.trim() || threadId.length > 512) fault();
    // Catalog failure must not prevent pausing/deleting a task or reading its history.
    const permissionProfiles = method.endsWith("/action") ? undefined
      : await this.port.permissionProfiles?.(threadId).catch(() => undefined);
    if (method === "opencraft/schedules/read") return { ...this.read(threadId), ...(permissionProfiles ? { permissionProfiles } : {}) };
    if (method !== "opencraft/schedules/save" && method !== "opencraft/schedules/action") throw new ScheduleFault(-32601, "Unsupported schedule method");
    await this.port.validate(threadId);
    if (method.endsWith("/save") && p.permissions != null &&
      (typeof p.permissions !== "string" || !permissionProfiles?.some(profile => profile.id === p.permissions && profile.allowed))) fault();
    if (this.stopped) throw new ScheduleFault(-32000, "Schedule service is closing");
    this.transaction(() => {
      const prior = this.schedule(threadId), now = this.now();
      if (!Number.isInteger(p.expectedRevision) || p.expectedRevision !== (prior?.revision ?? 0)) throw new ScheduleFault(-32009, "Schedule changed; reload before editing");
      const pending = this.runs(threadId).find(run => unfinished.has(run.state));
      if (method.endsWith("/save")) {
        if (pending) throw new ScheduleFault(-32009, "Previous occurrence is unfinished; review it before replacing the schedule");
        if (typeof p.prompt !== "string" || !p.prompt.trim() || p.prompt.length > 32000
          || !Number.isSafeInteger(p.nextRunAt) || Number(p.nextRunAt) < now - 5000
          || Number(p.nextRunAt) > now + 5 * 366 * 86400000
          || !(p.intervalMinutes === null || Number.isInteger(p.intervalMinutes) && Number(p.intervalMinutes) >= 1 && Number(p.intervalMinutes) <= 525600)
          || typeof p.timeZone !== "string") fault();
        try { new Intl.DateTimeFormat("en", { timeZone: p.timeZone }); } catch { fault(); }
        // Older editors preserve advanced rules rather than silently converting them.
        const calendar = p.calendar === undefined ? prior?.calendar ?? null : p.calendar;
        const window = p.window === undefined ? prior?.window ?? null : p.window;
        const skills = p.skills === undefined ? prior?.skills ?? [] : p.skills;
        if (calendar !== null && (!validScheduleCalendar(calendar) || p.intervalMinutes !== null)
          || window !== null && !validScheduleWindow(window)
          || !Array.isArray(skills) || skills.length > 32 || skills.some(s => typeof s !== "string" || !s.trim() || s.length > 512)) fault();
        const nextRunAt = calendar ? nextCalendarRun(calendar, p.timeZone, Math.max(now, Number(p.nextRunAt)), window)
          : p.intervalMinutes !== null ? nextIntervalRun(Number(p.nextRunAt), Number(p.intervalMinutes), p.timeZone, Math.max(now, Number(p.nextRunAt)), window) : Number(p.nextRunAt);
        if (nextRunAt === null || window && (nextRunAt < (window.startAt ?? -Infinity) || nextRunAt >= (window.endAt ?? Infinity))) fault();
        this.writeSchedule({ id: prior?.status !== "deleted" && prior ? prior.id : randomUUID(), threadId, prompt: p.prompt.trim(),
          permissions: p.permissions === undefined ? prior?.permissions ?? null : p.permissions as string | null,
          nextRunAt, intervalMinutes: p.intervalMinutes as number | null, timeZone: p.timeZone, calendar, window, skills,
          status: "active", revision: (prior?.revision ?? 0) + 1, createdBy: prior && prior.status !== "deleted" ? prior.createdBy : createdBy, updatedAt: now });
      } else {
        if (!prior || prior.status === "deleted" && p.action !== "review") fault();
        if (!["pause", "resume", "delete", "run-now", "review"].includes(String(p.action))) fault();
        if (p.action === "run-now" && (pending || prior.status !== "active")) throw new ScheduleFault(-32009, "Previous occurrence is unfinished");
        const value = { ...prior, revision: prior.revision + 1, updatedAt: now };
        if (p.action === "review") {
          if (!pending || pending.state !== "unknown") fault();
          this.writeRun({ ...pending, state: "reviewed", updatedAt: now });
          // Explicit acknowledgement is NOT successful execution and never resends.
          value.status = prior.status === "deleted" ? "deleted" : "paused";
        } else if (p.action === "pause" || p.action === "delete") {
          value.status = p.action === "pause" ? "paused" : "deleted";
          if (pending?.state === "waiting") this.writeRun({ ...pending, state: "failed", updatedAt: now });
        } else if (p.action === "resume") {
          const next = prior.calendar ? nextCalendarRun(prior.calendar, prior.timeZone, Math.max(now, prior.nextRunAt), prior.window)
            : prior.intervalMinutes !== null ? nextIntervalRun(prior.nextRunAt, prior.intervalMinutes, prior.timeZone, now, prior.window) : Math.max(now, prior.nextRunAt);
          if (next === null || prior.window?.endAt != null && next >= prior.window.endAt) throw new ScheduleFault(-32602, "Schedule has no future occurrence");
          value.status = "active"; value.nextRunAt = next;
        } else {
          this.writeRun({ id: `schedule:${prior.id}:manual:${value.revision}`, scheduleId: prior.id, threadId,
            scheduledAt: now, state: "waiting", turnId: null, updatedAt: now, permissions: prior.permissions ?? null });
        }
        this.writeSchedule(value);
      }
    });
    if (method.endsWith("/save") || p.action === "review" || p.action === "resume") this.retries.delete(threadId);
    this.rearm();
    return { ...this.read(threadId), ...(permissionProfiles ? { permissionProfiles } : {}) };
  }
  suspend(threadId: string) {
    if (this.stopped) return;
    this.transaction(() => {
      const plan = this.schedule(threadId);
      if (!plan || plan.status !== "active") return;
      const now = this.now();
      this.writeSchedule({ ...plan, status: "paused", revision: plan.revision + 1, updatedAt: now });
      for (const run of this.runs(threadId)) if (run.state === "waiting") this.writeRun({ ...run, state: "failed", updatedAt: now });
    });
    this.rearm();
  }
  executionChanged(event: ScheduleExecutionEvent) {
    if (this.stopped) return;
    const run = this.runs(event.threadId).find(value => value.state === "submitting" || value.state === "running" || value.state === "unknown" && value.turnId !== null);
    if (!run || run.turnId !== null && run.turnId !== event.turnId) return;
    this.observations.set(run.id, event);
    if (!this.retries.get(event.threadId)?.failed) this.retries.delete(event.threadId);
    void this.tick();
  }
  private observed(run: ConversationScheduleRun) {
    const event = this.observations.get(run.id);
    return event?.turnId === run.turnId ? { state: event.state } : undefined;
  }
  /** Arms the owner wake-up and catches up from durable state. Calling it again (admission reopened, engine
   * re-initialized) runs another catch-up pass. */
  start() {
    if (this.stopped) return;
    this.started = true;
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.admissionOpen()) { this.rearm(); return Promise.resolve(); }
    const operation = Promise.resolve().then(() => this.advance()).catch(() => this.diagnostic({ event: "schedule-tick-failed" }))
      .finally(() => this.rearm());
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation));
    return operation;
  }
  handoffObservation() {
    const plans = this.db.prepare("SELECT value FROM schedules").all().map(row => JSON.parse(String(row.value)));
    const runs = this.db.prepare("SELECT value FROM schedule_runs").all().map(row => JSON.parse(String(row.value)));
    if (plans.some(row => !row || typeof row.threadId !== "string" || !["active", "paused", "completed", "deleted"].includes(row.status))
      || runs.some(row => !row || typeof row.threadId !== "string" || !["waiting", "submitting", "running", "completed", "failed", "unknown", "reviewed"].includes(row.state))) throw new Error("Invalid schedule custody");
    return { flights: this.pending.size + this.flights.size, plans: plans.filter(row => ["active", "paused"].includes(row.status)).length,
      unfinished: runs.filter(row => unfinished.has(row.state)).length };
  }
  /** Earliest time a pass could start new work, by the same rules as advance(); null when nothing is pending. */
  private nextWake(): number | null {
    // A settling flight always runs another pass, which re-arms.
    if (this.flights.size >= MAX_FLIGHTS) return null;
    const now = this.now();
    let next: number | null = null;
    for (const plan of this.plans()) {
      if (this.flights.has(plan.threadId)) continue;
      const retry = this.retries.get(plan.threadId)?.at ?? -Infinity;
      const due = this.runs(plan.threadId).some(run => unfinished.has(run.state)) ? Math.max(now, retry)
        : plan.status === "active" ? Math.max(plan.nextRunAt, retry) : null;
      if (due !== null && (next === null || due < next)) next = due;
    }
    return next !== null && !this.admissionOpen() ? Math.max(next, now + FENCED_RECHECK_MS) : next;
  }
  private rearm() {
    if (!this.started || this.stopped) return;
    try {
      const next = this.nextWake();
      if (next === null) this.timer.cancel(); else this.timer.arm(next);
    } catch {
      // Unreadable state must not end scheduling: re-check later, as a failed pass would have.
      this.diagnostic({ event: "schedule-wake-failed" });
      this.timer.arm(this.now() + 30000);
    }
  }
  private async advance() {
    if (!this.admissionOpen()) return;
    const started: Promise<void>[] = [];
    for (const snapshot of this.plans()) {
      if (this.stopped || this.flights.size >= MAX_FLIGHTS) break;
      if (this.flights.has(snapshot.threadId) || (this.retries.get(snapshot.threadId)?.at ?? 0) > this.now()) continue;
      const run = this.runs(snapshot.threadId).find(run => unfinished.has(run.state));
      if (!run && !(snapshot.status === "active" && snapshot.nextRunAt <= this.now())) continue;
      const operation = Promise.resolve().then(() => this.advancePlan(snapshot))
        .catch(() => {
          this.retries.set(snapshot.threadId, { at: this.now() + 30000, failed: true });
          this.diagnostic({ event: "schedule-execution-check-failed", scheduleId: snapshot.id });
        })
        .finally(() => {
          this.flights.delete(snapshot.threadId);
          // Fill a released slot independently of other blocked conversations.
          if (!this.stopped) void this.tick();
        });
      this.flights.set(snapshot.threadId, operation);
      started.push(operation);
    }
    await Promise.all(started);
  }
  private async advancePlan(snapshot: ConversationSchedule) {
    let plan = this.schedule(snapshot.threadId)!;
    let run = this.runs(plan.threadId).find(value => unfinished.has(value.state));
    if (plan.status === "active" && plan.window?.endAt != null && this.now() >= plan.window.endAt && (!run || run.state === "waiting")) {
      this.transaction(() => {
        if (run) this.writeRun({ ...run, state: "failed", updatedAt: this.now() });
        this.writeSchedule({ ...plan, status: "completed", revision: plan.revision + 1, updatedAt: this.now() });
      });
      return;
    }
    if (!run && plan.status === "active" && plan.nextRunAt <= this.now()) {
      run = { id: `schedule:${plan.id}:${plan.nextRunAt}`, scheduleId: plan.id, threadId: plan.threadId,
        scheduledAt: plan.nextRunAt, state: "waiting", turnId: null, updatedAt: this.now(), permissions: plan.permissions ?? null };
      this.writeRun(run);
    }
    if (run?.state === "waiting" && plan.status !== "active") { this.writeRun({ ...run, state: "failed", updatedAt: this.now() }); return; }
    if (!run) return;
    if (run.state === "waiting" || run.state === "submitting") {
      // Persist intent before crossing the engine boundary. Re-entry uses the SAME ID.
      if (run.state === "waiting") { run = { ...run, state: "submitting", updatedAt: this.now() }; this.writeRun(run); }
      const occurrence = run;
      const prompt = plan.skills?.length ? `${plan.prompt}\n\nUse these installed skills for this task: ${plan.skills.join(", ")}` : plan.prompt;
      const result = await this.port.submit(run, prompt, () => {
        const current = this.schedule(occurrence.threadId);
        return !this.stopped && current?.id === occurrence.scheduleId && current.status === "active";
      });
      if (result.turnId && run.turnId && result.turnId !== run.turnId) throw new Error("Scheduled execution Turn binding changed");
      run = { ...run, state: result.state, turnId: result.turnId ?? run.turnId, updatedAt: this.now() };
      const observed = this.observed(run);
      if (run.state === "running" && observed) run = { ...run, ...observed };
    } else {
      let result: Awaited<ReturnType<ScheduleExecutionPort["inspect"]>> | undefined = this.observed(run);
      if (!result) {
        try { result = await this.port.inspect(run); }
        catch (error) { result = this.observed(run); if (!result) throw error; }
      }
      if (result.turnId && run.turnId && result.turnId !== run.turnId) throw new Error("Scheduled execution Turn binding changed");
      run = { ...run, state: result.state, turnId: result.turnId ?? run.turnId, updatedAt: this.now() };
    }
    // A human review may retire an unknown occurrence while inspection is in flight.
    if (this.runs(run.threadId).find(value => value.id === run!.id)?.state === "reviewed") return;
    // A native completion can arrive while inspection is awaiting its reply.
    const observation = this.observed(run);
    if (observation && (run.state === "running" || run.state === "unknown")) run = { ...run, ...observation };
    const settled = run;
    this.transaction(() => {
      this.writeRun(settled);
      plan = this.schedule(plan.threadId)!;
      if ((settled.state === "completed" || settled.state === "failed") && plan.status === "active" && !settled.id.includes(":manual:")) {
        const after = Math.max(this.now(), plan.nextRunAt) + 1;
        const next = plan.calendar ? nextCalendarRun(plan.calendar, plan.timeZone, after, plan.window)
          : plan.intervalMinutes !== null ? nextIntervalRun(plan.nextRunAt, plan.intervalMinutes, plan.timeZone, after, plan.window) : null;
        this.writeSchedule({ ...plan, status: next === null ? "completed" : "active",
          nextRunAt: next ?? plan.nextRunAt,
          revision: plan.revision + 1, updatedAt: this.now() });
      }
    });
    if (run.state === "unknown" && !this.retries.has(run.threadId)) this.diagnostic({ event: "schedule-needs-review", scheduleId: plan.id });
    if (run.state === "waiting" || run.state === "running" || run.state === "unknown") this.retries.set(run.threadId, { at: this.now() + (run.state === "waiting" ? 5000 : run.state === "unknown" || this.port.subscribe ? 60000 : 15000), failed: false });
    else { this.retries.delete(run.threadId); this.observations.delete(run.id); }
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.stopped = true;
      this.timer.cancel();
      this.unsubscribe?.();
      this.observations.clear();
      await Promise.all([...this.pending, ...this.flights.values()]);
      this.storage.close();
    })();
  }
}

/** Node owner: opens `conversation-schedules.sqlite` under the Host directory with the managed lifecycle and
 * lends it to the runtime-neutral domain. */
export class ConversationSchedules extends SqlConversationSchedules {
  readonly outcome: DatabaseOutcome;
  constructor(directory: string, port: ScheduleExecutionPort, now?: () => number,
    diagnostic?: (event: { event: string; scheduleId?: string }) => void, changed?: () => void,
    admissionOpen?: () => boolean, wakeTimer?: OwnerWakeTimerFactory) {
    const managed = openManagedDatabase({ schemaId: "host-schedules", path: join(directory, "conversation-schedules.sqlite"), legacyPolicy: "reject-unknown",
      validateSchema: createSchemaValidator(schema), migrations: CONVERSATION_SCHEDULE_MIGRATIONS });
    super({ database: nodeSqlDatabase(managed.database), close: () => managed.database.close() },
      port, now, diagnostic, changed, admissionOpen, wakeTimer);
    this.outcome = managed.outcome;
  }
}
