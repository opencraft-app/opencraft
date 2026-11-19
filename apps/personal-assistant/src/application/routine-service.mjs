import { CalendarSchedule } from "../domain/calendar-schedule.mjs";
import { notificationPolicy } from "../domain/notification-policy.mjs";
import { Routine } from "../domain/routine.mjs";
import { digest, requireRevision } from "../domain/values.mjs";

/** Owns definitions and occurrence creation; the runtime only asks it to tick. */
export class RoutineService {
  constructor({ uow, repositories: r, inbox, works, history, attention, scope, now = Date.now }) {
    Object.assign(this, {
      uow,
      r,
      inbox,
      works,
      history,
      attention,
      scope,
      now,
    });
  }
  add(inputId, params, resources) {
    Routine.validate(params);
    const notify = notificationPolicy(params.notify);
    const schedule = params.schedule === undefined ? null : CalendarSchedule.normalize(params.schedule);
    return this.inbox.accept(
      inputId,
      "routine.add",
      resources === undefined ? params : { ...params, capturedResources: resources },
      () => {
        const captured = this.scope.delegate(inputId, resources).resources;
        this.attention.active();
        const id = `routine_${digest(inputId).slice(0, 24)}`;
        const nextAt = schedule
          ? CalendarSchedule.next(schedule, Math.max(this.now() - 1, (params.startAt ?? this.now()) - 1))
          : params.startAt;
        if (nextAt === null || (params.expiresAt !== undefined && nextAt >= params.expiresAt))
          throw new Error("Schedule has no occurrence before its deadline");
        this.r.routines.add({
          id,
          text: params.text,
          revision: 1,
          status: "active",
          interval_ms: params.intervalMs ?? 0,
          schedule_json: schedule ? JSON.stringify(schedule) : null,
          stop_when: params.stopWhen ?? null,
          last_scheduled_at: null,
          next_at: nextAt,
          expires_at: params.expiresAt ?? null,
          max_runs: params.maxRuns ?? null,
          created_count: 0,
          notify,
          resources_json: JSON.stringify(captured),
        });
        this.r.events.append("routine.created", null, { routineId: id }, this.now());
        return { routineId: id, revision: 1 };
      },
    );
  }
  stop(id, status) {
    const r = this.r.routines.get(id);
    if (!r) throw new Error("Unknown routine");
    this.r.routines.save({ ...r, status, revision: r.revision + 1 });
    for (const w of this.r.works.forRoutine(id)) this.works.cancelWork(w.id, w.revision);
    this.r.events.append(`routine.${status}`, null, { routineId: id }, this.now());
  }
  pause(inputId, params) {
    return this.inbox.accept(inputId, "routine.pause", params, () => {
      const record = this.r.routines.get(params.routineId);
      if (!record) throw new Error("Unknown routine");
      if (params.expectedRevision !== undefined) requireRevision(params.expectedRevision, record.revision, "routine");
      this.stop(params.routineId, "paused");
      return { routineId: params.routineId, status: "paused" };
    });
  }
  resume(inputId, params) {
    return this.inbox.accept(inputId, "routine.resume", params, () => {
      const record = this.r.routines.get(params.routineId);
      if (record && params.expectedRevision !== undefined)
        requireRevision(params.expectedRevision, record.revision, "routine");
      if (!record || record.status !== "paused") throw new Error("Only paused routines can resume");
      if (record.expires_at !== null && record.expires_at <= this.now()) throw new Error("Routine has expired");
      if (record.max_runs !== null && record.created_count >= record.max_runs)
        throw new Error("Routine run limit exhausted");
      const nextAt = record.schedule_json
        ? CalendarSchedule.next(JSON.parse(record.schedule_json), this.now() - 1, record.last_scheduled_at)
        : this.now();
      if (nextAt === null || (record.expires_at !== null && nextAt >= record.expires_at))
        throw new Error("Schedule has no future occurrence before its deadline");
      this.r.routines.save({
        ...record,
        status: "active",
        revision: record.revision + 1,
        next_at: nextAt,
      });
      this.attention.active();
      return {
        routineId: record.id,
        status: "active",
        revision: record.revision + 1,
      };
    });
  }
  update(inputId, params) {
    return this.inbox.accept(inputId, "routine.update", params, () => {
      const record = this.r.routines.get(params.routineId);
      if (!record) throw new Error("Unknown routine");
      if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 1)
        throw new Error("Routine update needs an explicit revision");
      requireRevision(params.expectedRevision, record.revision, "routine");
      const definition = params.definition;
      Routine.validate(definition);
      const schedule = definition.schedule === undefined ? null : CalendarSchedule.normalize(definition.schedule);
      const nextAt = schedule
        ? CalendarSchedule.next(
            schedule,
            Math.max(this.now() - 1, (definition.startAt ?? this.now()) - 1),
            record.last_scheduled_at,
          )
        : definition.startAt;
      if (nextAt === null || (definition.expiresAt !== undefined && nextAt >= definition.expiresAt))
        throw new Error("Schedule has no occurrence before its deadline");
      // Retire pending/active work from the old instruction, preserving its history.
      for (const w of this.r.works.forRoutine(record.id)) this.works.cancelWork(w.id, w.revision);
      this.r.routines.save({
        ...record,
        text: definition.text,
        stop_when: definition.stopWhen ?? null,
        interval_ms: definition.intervalMs ?? 0,
        schedule_json: schedule ? JSON.stringify(schedule) : null,
        next_at: nextAt,
        expires_at: definition.expiresAt ?? null,
        max_runs: definition.maxRuns ?? null,
        created_count: 0,
        revision: record.revision + 1,
        status: record.status === "paused" ? "paused" : "active",
        notify: notificationPolicy(definition.notify),
      });
      this.r.events.append(
        "routine.updated",
        null,
        { routineId: record.id, revision: record.revision + 1 },
        this.now(),
      );
      return { routineId: record.id, revision: record.revision + 1 };
    });
  }
  finishWatch(work) {
    this.works.assertCurrent(work);
    const record = this.r.routines.get(work.routine_id);
    if (!record || !record.stop_when || record.revision !== work.routine_revision)
      throw new Error("Only the current conditional watch can be finished");
    // Disarm future occurrences while allowing this run's original delivery to settle.
    this.r.routines.save({
      ...record,
      status: "exhausted",
      max_runs: record.created_count,
    });
    this.r.events.append(
      "routine.condition-observed",
      work.id,
      {
        routineId: record.id,
        condition: record.stop_when,
        verification: "model-reported",
      },
      this.now(),
    );
  }
  tick(now = this.now()) {
    // Idle observation: a unit of work rescans memory files, so do not open one
    // every pump when no routine exists. The transaction re-reads before acting.
    if (!this.r.routines.active().length) return;
    this.uow.transaction(() => {
      if (this.r.routines.active().length && this.attention.assess() === "pause") {
        for (const record of this.r.routines.active()) this.stop(record.id, "paused");
        return;
      }
      for (const record of this.r.routines.active()) {
        const routine = new Routine(record),
          due = routine.due(now, this.r.works.routineBusy(record.id));
        if (due === "expire") {
          this.stop(record.id, "expired");
          continue;
        }
        if (due !== "trigger") continue;
        const occurrenceId = `occ_${digest([record.id, record.revision, record.next_at]).slice(0, 24)}`,
          workId = `w_${digest(occurrenceId).slice(0, 24)}`;
        this.inbox.accept(
          occurrenceId,
          "occurrence",
          {
            routineId: record.id,
            revision: record.revision,
            scheduledAt: record.next_at,
          },
          () => {
            this.works.create(
              workId,
              record.text,
              occurrenceId,
              "routine",
              record,
              undefined,
              record.resources_json ? JSON.parse(record.resources_json) : [],
              {
                kind: "routine",
                key: record.id,
                notify: record.notify,
                quietOrigin: true,
                stopWhen: record.stop_when ?? null,
                scheduledAt: record.next_at,
                observedAt: now,
              },
            );
            if (record.notify !== "never" || record.stop_when) this.history.link(this.history.main.id, workId);
            return { workId, revision: 1, occurrenceId };
          },
        );
        this.attention.fired();
        this.r.routines.occurrence({
          id: occurrenceId,
          routineId: record.id,
          revision: record.revision,
          scheduledAt: record.next_at,
          observedAt: now,
          workId,
        });
        this.r.routines.save(routine.triggered(now));
        this.r.events.append(
          "routine.triggered",
          workId,
          { occurrenceId, scheduledAt: record.next_at, observedAt: now },
          now,
        );
      }
    });
  }
}
