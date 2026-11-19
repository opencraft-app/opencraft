import { ExecutionThreadLinks } from "./execution-threads.mjs";
import { RunLimitError } from "../domain/run-policy.mjs";
import { workOrigin } from "../domain/notification-policy.mjs";
import { CompletionContract } from "../domain/completion-contract.mjs";
import { stable, requireText } from "../domain/values.mjs";
/** Owns business execution bindings; native tasks/checkpoints remain exclusively in ExecutionPort. */
export class ExecutionService {
  constructor({
    uow,
    repositories: r,
    works,
    memory,
    scope,
    ledger,
    inbox,
    history,
    skills,
    ready = () => true,
    goalInputs = () => [],
    confirmedInputs = () => ({ items: [], omitted: false }),
    reportReceiver = () => false,
    now = Date.now,
  }) {
    Object.assign(this, {
      uow,
      r,
      works,
      memory,
      scope,
      ledger,
      inbox,
      history,
      skills,
      ready,
      goalInputs,
      confirmedInputs,
      reportReceiver,
      now,
    });
  }
  get threads() {
    return (this.threadLinks ??= new ExecutionThreadLinks({
      uow: this.uow,
      repository: this.r.executions,
      execution: (work) => this.execution(work),
      check: (work) => this.assertThreadAction(work),
      ready: (work) => this.ready(work),
    }));
  }
  execution(work) {
    return this.ledger.get(work);
  }
  predecessor(work) {
    return this.ledger.predecessor(this.execution(work));
  }
  requiredHarnesses() {
    return this.r.executions.requiredHarnesses();
  }
  requiredNativeBindings() {
    return this.r.executions.nativeBindings();
  }
  nativeCalls(work) {
    return this.r.executions.nativeCalls(this.execution(work).id);
  }
  prepareNativeCall(work, callId, tool, args) {
    requireText(callId, "native call id", 300);
    requireText(tool, "native tool", 160);
    const encoded = stable(args);
    if (encoded.length > 150000) throw new Error("Native arguments exceed bound");
    return this.uow.transaction(() => {
      this.works.assertCurrent(work);
      const e = this.execution(work);
      if (e.harness !== "codex") throw new Error("Native receipts require a Codex-owned execution");
      const old = this.r.executions.nativeCall(e.id, callId);
      if (old) {
        if (old.tool !== tool || old.args_json !== encoded)
          throw new Error("Native call identity reused with different intent");
        return old;
      }
      if (this.r.executions.nativeCalls(e.id).length >= 1024) throw new Error("Native receipt bound exceeded");
      this.r.executions.prepareNativeCall(e.id, callId, tool, args);
      return this.r.executions.nativeCall(e.id, callId);
    });
  }
  nativeOutcome(work, callId, state, output) {
    if (!["waiting", "completed"].includes(state) || stable(output).length > 1100000)
      throw new Error("Invalid native outcome");
    return this.uow.transaction(() => {
      this.works.assertCurrent(work);
      const e = this.execution(work),
        old = this.r.executions.nativeCall(e.id, callId);
      if (!old) throw new Error("Native outcome has no recorded intent");
      if (old.state === "completed") {
        if (old.output_json !== stable(output)) throw new Error("Immutable native outcome changed");
        return old;
      }
      this.r.executions.nativeOutcome(e.id, callId, state, output);
      return this.r.executions.nativeCall(e.id, callId);
    });
  }
  observeRun(work, observation) {
    this.uow.transaction(() => {
      const e = this.ledger.get(work);
      const previous = e.guard_json ? JSON.parse(e.guard_json) : { steps: 0 };
      this.ledger.guard(work, {
        ...previous,
        lastRun: {
          elapsedMs: observation.elapsedMs,
          outcome: observation.outcome,
        },
      });
    });
  }
  modelStep(work, taskId, limit) {
    if (taskId == null || !Number.isSafeInteger(limit) || limit < 1 || limit > 5000)
      throw new Error("Invalid model-step boundary");
    const denied = this.uow.transaction(() => {
      this.works.assertCurrent(work);
      const e = this.ledger.get(work),
        previous = e.guard_json ? JSON.parse(e.guard_json) : { steps: 0 };
      if (previous.lastTaskId === String(taskId)) return false;
      if (previous.steps >= limit) {
        this.ledger.guard(work, {
          ...previous,
          lastLimit: limit,
          stopReason: "steps",
        });
        return true;
      }
      this.ledger.guard(work, {
        steps: previous.steps + 1,
        lastTaskId: String(taskId),
        lastLimit: limit,
      });
      return false;
    });
    if (denied) throw new RunLimitError("steps", limit);
  }
  savedReport(work) {
    return this.ledger.report(work);
  }
  snapshot(work) {
    return this.uow.transaction(() => {
      this.works.assertCurrent(work);
      if (!this.ready(work)) throw new Error("Goal paused or dependency no longer valid");
      const e = this.execution(work);
      if (e.context_json) return JSON.parse(e.context_json);
      const directives = this.ledger.contextDirectives(work);
      const value = {
        workId: work.id,
        executionId: e.id,
        revision: work.revision,
        text: work.text,
        origin: workOrigin(work),
        completion: CompletionContract.forWork(this.works.require(work.id).record),
        skills: this.skills.snapshot(),
        memoryEpoch: this.memory.epoch(),
        explicitMemoryEpoch: this.memory.guardEpoch(),
        memoryContext: this.memory.prompt(this.scope.forWork(work, e.input_id).record.resources),
        memories: this.memory
          .recall({ limit: 20 }, this.scope.forWork(work, e.input_id).record.resources)
          .items.map(({ key, value, revision }) => ({ key, value, revision })),
        delegation: this.scope.forWork(work, e.input_id).toJSON(),
        ...(e.request_json ? { request: JSON.parse(e.request_json) } : {}),
        dependencyResults: this.goalInputs?.(work) ?? [],
        confirmedInputs: e.predecessor_id ? this.confirmedInputs(work) : { items: [], omitted: false },
        directives: directives.items,
        directivesOmitted: directives.omitted,
      };
      this.ledger.snapshot(e, value);
      return value;
    });
  }
  report(work, text = "", error = null) {
    return this.uow.transaction(() => {
      const platform = this.threads.report(work, text, error);
      if (platform.held) return { held: true };
      text = platform.text;
      error = platform.error;
      const receipt = this.ledger.recordReport(work, text, error, this.now());
      if (!receipt.duplicate)
        this.r.events.append(
          "execution.reported",
          work.id,
          {
            reportId: receipt.report.id,
            revision: work.revision,
            status: receipt.report.status,
          },
          this.now(),
        );
      const current = this.works.require(work.id).record;
      if (
        current.revision !== work.revision ||
        (work.active_execution_id && current.active_execution_id !== work.active_execution_id) ||
        ["cancelled", "completed"].includes(current.status)
      )
        return { ...receipt, stale: true };
      if (!this.ready(current)) return { ...receipt, stale: true };
      if (current.routine_id) {
        const routine = this.r.routines.get(current.routine_id);
        if (
          !routine ||
          routine.revision !== current.routine_revision ||
          ["paused", "expired"].includes(routine.status) ||
          (routine.expires_at !== null && routine.expires_at <= this.now())
        ) {
          this.works.blocked(current, "Routine no longer permits this execution report");
          return { ...receipt, stale: true };
        }
      }
      if (this.r.executions.directives(work.id, "accepted").length && error === null) {
        this.works.awaitingReview(current);
        this.ledger.mark(current, "reported");
        this.works.continue(`directives:${receipt.report.id}`, {
          workId: work.id,
          expectedRevision: work.revision,
          text: "Process the ordered supplemental instructions without changing the original requirements.",
        });
        return { ...receipt, routed: true };
      }
      const routed = this.reportReceiver(receipt.report, current);
      if (routed && ["queued", "running"].includes(current.status)) {
        this.works.awaitingReview(current);
        this.ledger.mark(current, "reported");
      }
      return { ...receipt, routed };
    });
  }
  reportProgress() {
    const stale = (work) => work.status === "running" && this.now() - work.updated_at >= 30000;
    // Observation only; the transaction below re-reads and records the notice.
    if (!this.r.works.pending().some(stale)) return;
    this.uow.transaction(() => {
      for (const work of this.r.works.pending()) {
        if (work.status === "running" && this.now() - work.updated_at >= 30000)
          this.history.workNotice(work, "progress");
      }
    });
  }
  started(work) {
    this.uow.transaction(() => {
      if (!this.ready(work)) throw new Error("Goal paused or dependency no longer valid");
      this.works.started(work);
      this.ledger.mark(work, "running");
      this.r.events.append("execution.started", work.id, { revision: work.revision }, this.now());
    });
  }
  bound(work, conversationId, submissionId, { admitted = true } = {}) {
    this.uow.transaction(() => {
      this.works.assertCurrent(work);
      const e = this.execution(work);
      this.ledger.bind(e, conversationId, submissionId);
      if (admitted) this.ledger.submittedDirectives(e);
      if (admitted && this.r.inputs.get(e.input_id)?.delivered_at == null) {
        this.inbox.delivered(e.input_id);
        this.r.events.append("input.delivered", work.id, { executionId: e.id, submissionId }, this.now());
      }
    });
  }
  blocked(work, error) {
    this.uow.transaction(() => {
      if (this.works.blocked(work, error)) {
        this.ledger.mark(work, "blocked");
        this.history.workNotice(work, "execution-blocked");
        this.r.events.append("execution.blocked", work.id, { error: String(error) }, this.now());
      }
    });
  }
  assertThreadAction(work) {
    const resource = this.scope.forWork(work).record.resources.find((r) => r.id === "platform.threads");
    if (!resource) throw Error("Work has no captured platform Thread binding");
    this.assertAction(work, "thread_command", resource);
  }
  assertAction(work, tool, resource, expectedMemoryEpoch) {
    const current = this.works.assertCurrent(work);
    if (
      current.status === "blocked" ||
      (current.status === "waiting_input" && !["ask_user", "request_intervention"].includes(tool))
    )
      throw new Error("Work must resolve its pending information before acting");
    if (!this.ready(current)) throw new Error("Goal paused or dependency no longer valid");
    this.scope.check(work, tool, resource);
    if (
      expectedMemoryEpoch !== undefined &&
      (typeof expectedMemoryEpoch === "object"
        ? expectedMemoryEpoch.epoch !== this.memory.guardEpoch()
        : expectedMemoryEpoch !== this.memory.epoch())
    )
      throw new Error("Memory changed during this execution; revise the work to use fresh context");
  }
}
