/** Ephemeral scheduling owner. Durable business state is always queried from application services. */
export class WorkCoordinator {
  constructor({ app, executor, concurrency, afterResult = () => {}, onError = () => {}, telemetry }) {
    Object.assign(this, { app, executor, concurrency, afterResult, onError });
    this.telemetry = telemetry;
    this.active = new Map();
    this.stopping = false;
  }
  tick() {
    this.app.executions.reportProgress();
    for (const [id, task] of this.active) {
      const work = this.app.workRecord(id);
      if (
        work.status === "cancelled" ||
        work.revision !== task.revision ||
        work.active_execution_id !== task.executionId ||
        !this.app.executions.ready(work)
      )
        task.controller.abort();
    }
    const scheduling = new Set(this.active.keys());
    // Free the local model slot, but do not bypass a Goal's logical parallelism limit.
    for (const id of this.app.executions.threads?.waitingWorks() ?? []) scheduling.add(id);
    for (const work of this.app.pendingWorks(scheduling)) {
      if (this.active.size >= this.concurrency) break;
      if (this.active.has(work.id) || this.app.executions.threads?.held(work)) continue;
      const controller = new AbortController(),
        task = {
          controller,
          revision: work.revision,
          executionId: work.active_execution_id,
        };
      this.active.set(work.id, task);
      task.promise = this.execute(work, controller.signal)
        .catch(this.onError)
        .finally(() => this.active.delete(work.id));
    }
  }
  async execute(work, signal) {
    return this.telemetry
      ? this.telemetry.run("work.execute", {}, () => this.executeAttempt(work, signal))
      : this.executeAttempt(work, signal);
  }
  async executeAttempt(work, signal) {
    const saved = this.app.executions.savedReport(work);
    if (saved) return this.settleReport(work, saved.text, saved.error);
    let answer;
    try {
      this.app.executions.started(work);
      answer = await this.executor.run(work, signal);
    } catch (error) {
      if (!this.stopping && !signal.aborted && this.app.executions.ready(this.app.workRecord(work.id)))
        this.settleReport(work, "", error);
      return;
    }
    if (this.stopping || answer?.status === "waiting_input") return;
    this.settleReport(work, answer);
  }
  settleReport(work, text, error = null) {
    const observed = this.app.executions.report(work, text, error);
    if (observed.held) return;
    if (observed.stale) return;
    if (!observed.routed && observed.report.error !== null) {
      this.app.executions.blocked(work, observed.report.error);
      return;
    }
    const receipt = observed.routed ? { accepted: true } : this.app.outcomes.record(work, observed.report.text);
    if (receipt.accepted) this.afterResult(observed.routed ? "report" : "result");
  }
  async suspend() {
    this.stopping = true;
    await this.executor.suspendAll();
    await Promise.allSettled([...this.active.values()].map((t) => t.promise));
  }
}
