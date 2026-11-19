import { digest, requireText, requireRevision } from "../domain/values.mjs";
import { goalTasks, goalLimits } from "../domain/goal.mjs";

/** Owns goals, plan relations and consumed dependency references, not work lifecycle. */
export class GoalService {
  constructor({ repository, inbox, uow, workPort, history, resources, now = Date.now }) {
    Object.assign(this, {
      repository,
      inbox,
      uow,
      workPort,
      history,
      resources,
      now,
    });
  }
  require(id) {
    const g = this.repository.get(requireText(id, "goalId", 160));
    if (!g) throw new Error("Unknown goal");
    return g;
  }
  forWork(workId) {
    return this.repository.forWork(workId)?.id ?? null;
  }
  assertEditable(workId) {
    const g = this.repository.forWork(workId);
    if (g && ["cancelled", "achieved"].includes(g.state))
      throw new Error("Goal is closed; explicitly reopen an achieved goal before changing its work");
  }
  rebase(inputId, params) {
    return this.inbox.accept(inputId, "goal.rebase", params, () => {
      const g = this.require(params.goalId);
      if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 1)
        throw new Error("Goal revision is required");
      requireRevision(params.expectedRevision, g.revision, "goal");
      if (!["active", "paused"].includes(g.state)) throw new Error("Goal is closed");
      this.assertMember(g.id, params.workId);
      const w = this.workPort.read(params.workId),
        deps = this.repository.dependencies(w.id);
      if (!Number.isSafeInteger(params.expectedWorkRevision) || params.expectedWorkRevision < 1)
        throw new Error("Work revision is required");
      requireRevision(params.expectedWorkRevision, w.revision, "work");
      if (
        !deps.length ||
        !Array.isArray(params.dependencies) ||
        params.dependencies.length !== deps.length ||
        new Set(params.dependencies.map((d) => d.workId)).size !== deps.length
      )
        throw new Error("Rebase must name every existing dependency exactly once");
      for (const dep of deps) {
        const next = params.dependencies.find((d) => d.workId === dep.upstream_id),
          upstream = this.workPort.read(dep.upstream_id);
        if (!next || next.revision !== upstream.revision) throw new Error("Stale dependency revision");
        this.repository.rebind(w.id, upstream.id, upstream.revision);
      }
      // Changing the required input versions is a contract change, never rewrite a consumed snapshot.
      this.workPort.amend(`goal-rebase:${digest(inputId)}`, {
        workId: w.id,
        expectedRevision: w.revision,
        text: w.text,
      });
      this.repository.update({ ...g, revision: g.revision + 1 });
      return this.detail(g.id);
    });
  }
  create(inputId, params, capturedResources, conversationId) {
    return this.inbox.accept(
      inputId,
      "goal.create",
      {
        ...params,
        capturedResources,
        ...(conversationId ? { conversationId } : {}),
      },
      () => {
        const d = params.definition,
          objective = requireText(d?.objective, "goal objective");
        if (!Array.isArray(d.criteria) || !d.criteria.length || d.criteria.length > 16)
          throw new Error("Goal needs 1..16 explicit acceptance criteria");
        const criteria = d.criteria.map((text, i) => ({
          id: `criterion-${i + 1}`,
          text: requireText(text, "criterion", 1000),
        }));
        if (new TextEncoder().encode(JSON.stringify({ objective, criteria })).byteLength > 6000)
          throw new Error("Goal objective and criteria exceed the 6000-byte brief bound");
        const tasks = goalTasks(d.tasks),
          limits = goalLimits(d.priority, d.maxParallel);
        const id = `g_${digest(inputId).slice(0, 24)}`;
        const resources = capturedResources ?? this.resources(inputId);
        this.repository.add({
          id,
          objective,
          criteria,
          ...limits,
          resources,
          at: this.now(),
        });
        this.addTasks(id, tasks, inputId, resources, conversationId);
        return this.detail(id);
      },
    );
  }
  addTasks(goalId, tasks, inputId, resources, conversationId) {
    const members = new Map(this.repository.members(goalId).map((w) => [w.task_key, w]));
    for (const t of tasks) {
      const workId = `w_${digest([goalId, t.key]).slice(0, 24)}`;
      const taskInput = `goal-work:${digest([goalId, t.key])}`;
      this.inbox.accept(taskInput, "goal.work", { goalId, task: t, resources }, () =>
        this.workPort.create(
          workId,
          t.text,
          taskInput,
          "goal",
          null,
          t.completion,
          resources,
          { kind: "direct", notify: "always" },
          {
            original: {
              inputId,
              text: this.require(goalId).objective,
              ...(conversationId ? { conversationId } : {}),
            },
            goalId,
          },
        ),
      );
      this.repository.link(goalId, workId, t.key);
      this.history.link(workId, conversationId);
      members.set(t.key, this.workPort.read(workId));
    }
    for (const t of tasks)
      for (const key of t.dependsOn) {
        const upstream = members.get(key);
        this.repository.depend(members.get(t.key).id, upstream.id, upstream.revision);
      }
  }
  extend(inputId, params, capturedResources) {
    return this.inbox.accept(inputId, "goal.extend", { ...params, capturedResources }, () => {
      const g = this.require(params.goalId);
      if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 1)
        throw new Error("Goal revision is required");
      requireRevision(params.expectedRevision, g.revision, "goal");
      if (g.state !== "active") throw new Error("Only active goals can extend their plan");
      const members = this.repository.members(g.id);
      const tasks = goalTasks(
        params.tasks,
        members.map((w) => w.task_key),
      );
      this.addTasks(g.id, tasks, inputId, JSON.parse(g.resources_json), this.history.origin?.(members[0]?.id));
      this.repository.update({ ...g, revision: g.revision + 1 });
      return this.detail(g.id);
    });
  }
  change(inputId, op, params) {
    return this.inbox.accept(inputId, op, params, () => {
      const g = this.require(params.goalId);
      if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 1)
        throw new Error("Goal revision is required");
      requireRevision(params.expectedRevision, g.revision, "goal");
      if (g.state === "cancelled" || (g.state === "achieved" && op !== "goal.reopen"))
        throw new Error("Goal is already closed");
      const next = { ...g, revision: g.revision + 1 };
      if (op === "goal.reopen") {
        if (g.state !== "achieved") throw new Error("Only an achieved goal can be reopened");
        next.state = "active";
        next.confirmation_json = null;
      } else if (op === "goal.update") {
        const limits = goalLimits(params.priority ?? g.priority, params.maxParallel ?? g.max_parallel);
        next.priority = limits.priority;
        next.max_parallel = limits.maxParallel;
      } else if (op === "goal.pause") next.state = "paused";
      else if (op === "goal.resume") next.state = "active";
      else if (op === "goal.cancel") {
        next.state = "cancelled";
        for (const w of this.repository.members(g.id)) this.workPort.cancel(w.id, w.revision);
      } else throw new Error("Unknown goal change");
      this.repository.update(next);
      return this.detail(g.id);
    });
  }
  confirm(inputId, params) {
    return this.review(inputId, params, "owner");
  }
  review(inputId, params, origin = "model") {
    if (!["owner", "model"].includes(origin)) throw new Error("Invalid review origin");
    return this.inbox.accept(inputId, "goal.review", { params, origin }, () => {
      const g = this.require(params.goalId);
      if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 1)
        throw new Error("Goal revision is required");
      requireRevision(params.expectedRevision, g.revision, "goal");
      if (g.state !== "active") throw new Error("Only active goals can be confirmed");
      const view = this.detail(g.id);
      if (!view.readyForReview) throw new Error("Goal still has missing or invalidated results");
      const criteria = JSON.parse(g.criteria_json),
        evidence = params.evidence;
      if (
        !Array.isArray(evidence) ||
        evidence.length !== criteria.length ||
        new Set(evidence.map((e) => e.criterionId)).size !== criteria.length
      )
        throw new Error("Every criterion needs an explicit evidence assessment");
      const resultIds = new Set(view.works.map((w) => w.resultId));
      for (const c of criteria) {
        const e = evidence.find((e) => e.criterionId === c.id);
        requireText(e?.statement, "criterion evidence", 2000);
        if (!Array.isArray(e.resultIds) || !e.resultIds.length || e.resultIds.some((id) => !resultIds.has(id)))
          throw new Error("Criterion references unavailable results");
      }
      this.repository.update({
        ...g,
        revision: g.revision + 1,
        state: "achieved",
        confirmation_json: JSON.stringify({
          kind: origin === "owner" ? "owner-attested" : "model-reviewed",
          evidence,
          at: this.now(),
          inputId,
        }),
      });
      return this.detail(g.id);
    });
  }
  assertMember(goalId, workId) {
    if (this.repository.forWork(workId)?.id !== goalId) throw new Error("Report cannot control an unrelated goal");
  }
  reasons(work, includeState = true, visited = new Set()) {
    const g = this.repository.forWork(work.id);
    if (!g) return [];
    if (visited.has(work.id)) return [];
    visited.add(work.id);
    const reasons = !includeState || g.state === "active" ? [] : [`goal-${g.state}`];
    for (const dep of this.repository.dependencies(work.id)) {
      const result = this.repository.result(dep.upstream_id, dep.revision);
      if (!result || !JSON.parse(result.assessment_json).passed)
        reasons.push(`dependency:${dep.upstream_id}:r${dep.revision}`);
      if (this.reasons(this.workPort.read(dep.upstream_id), false, visited).length)
        reasons.push(`invalid-upstream:${dep.upstream_id}`);
    }
    if (work.active_execution_id)
      for (const input of this.repository.inputs(work.active_execution_id)) {
        const upstream = this.workPort.read(input.upstream_id);
        const current = this.repository.result(upstream.id, upstream.revision);
        if (current?.id !== input.result_id) reasons.push(`stale-input:${input.upstream_id}`);
      }
    return reasons;
  }
  capture(work) {
    const reasons = this.reasons(work);
    if (reasons.length) throw new Error(`Work is not ready: ${reasons.join(", ")}`);
    const old = this.repository.inputs(work.active_execution_id);
    if (old.length) return this.describeInputs(old);
    for (const dep of this.repository.dependencies(work.id)) {
      const result = this.repository.result(dep.upstream_id, dep.revision);
      this.repository.input(work.active_execution_id, dep.upstream_id, result.id);
    }
    return this.describeInputs(this.repository.inputs(work.active_execution_id));
  }
  describeInputs(inputs) {
    const perInput = Math.floor(12000 / Math.max(1, inputs.length));
    return inputs.map((input) => {
      const w = this.workPort.read(input.upstream_id),
        result = this.repository.result(w.id, w.revision);
      if (result?.id !== input.result_id) throw new Error("Dependency changed after admission");
      return {
        resultId: result.id,
        workId: result.work_id,
        revision: result.revision,
        text: result.text.slice(0, perInput),
        truncated: result.text.length > perInput,
      };
    });
  }
  detail(id) {
    const g = this.require(id),
      works = this.repository.members(id).map((w) => {
        const result = this.repository.result(w.id, w.revision);
        return {
          id: w.id,
          key: w.task_key,
          revision: w.revision,
          status: w.status,
          resultId: result?.id ?? null,
          waitingOn: this.reasons(w, false),
        };
      });
    return {
      id: g.id,
      objective: g.objective,
      criteria: JSON.parse(g.criteria_json),
      revision: g.revision,
      state: g.state,
      priority: g.priority,
      maxParallel: g.max_parallel,
      works,
      readyForReview: works.length > 0 && works.every((w) => w.resultId && !w.waitingOn.length),
      semanticReview: g.confirmation_json ? JSON.parse(g.confirmation_json) : { kind: "unverified" },
    };
  }
  list() {
    return this.repository.list().map((g) => this.detail(g.id));
  }
  schedule(works, active) {
    const counts = new Map(),
      selected = [],
      groups = new Map();
    for (const id of active) {
      const g = this.repository.forWork(id);
      if (g) counts.set(g.id, (counts.get(g.id) ?? 0) + 1);
    }
    for (const work of works) {
      if (active.has(work.id) || this.reasons(work).length) continue;
      const g = this.repository.forWork(work.id),
        key = g?.id ?? work.id;
      if (!groups.has(key))
        groups.set(key, {
          g,
          lastServed: g ? Math.max(...this.repository.members(g.id).map((w) => w.updated_at)) : work.updated_at,
          works: [],
        });
      groups.get(key).works.push(work);
    }
    // Bounded priority plus aging; round-robin within each scheduling pass.
    const buckets = [...groups.values()].sort((a, b) => {
      const score = (x) => (x.g?.priority ?? 1) + Math.max(0, this.now() - x.lastServed) / 60000;
      return score(b) - score(a) || a.works[0].created_at - b.works[0].created_at;
    });
    while (buckets.some((b) => b.works.length))
      for (const b of buckets) {
        const w = b.works.shift();
        if (!w) continue;
        if (b.g && (counts.get(b.g.id) ?? 0) >= b.g.max_parallel) {
          b.works = [];
          continue;
        }
        selected.push(w);
        if (b.g) counts.set(b.g.id, (counts.get(b.g.id) ?? 0) + 1);
      }
    return selected;
  }
}
