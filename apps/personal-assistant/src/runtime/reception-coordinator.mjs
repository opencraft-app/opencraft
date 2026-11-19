import { withRequestDeadline } from "../adapters/local/request-deadline.mjs";
/** One reception model call at a time; it has no dependency on worker slot availability. */
export class ReceptionCoordinator {
  constructor(
    service,
    planner,
    { afterProposal = () => {}, onError = () => {}, timeoutMs = 120000, context = null, telemetry } = {},
  ) {
    Object.assign(this, {
      service,
      planner,
      afterProposal,
      onError,
      timeoutMs,
      context,
      telemetry,
    });
    this.task = null;
    this.stopping = false;
    this.userStreak = 0;
  }
  tick() {
    if (this.stopping) return;
    if (this.task) return;
    const pending = this.service.pending();
    const user = pending.find((t) => !t.source_json),
      background = pending.find((t) => t.source_json);
    const turn = user && (!background || this.userStreak < 3) ? user : background;
    if (!turn) return;
    this.userStreak = turn.source_json ? 0 : this.userStreak + 1;
    const controller = new AbortController();
    this.controller = controller;
    this.task = this.process(turn, controller.signal)
      .catch(this.onError)
      .finally(() => {
        this.task = null;
      });
  }
  async process(turn, signal) {
    return this.telemetry
      ? this.telemetry.run(
          "reception.process",
          {
            "app.phase": turn.source_json ? "report" : "user",
            "app.queue_wait_ms": Math.max(0, Date.now() - turn.created_at),
          },
          () => this.processAttempt(turn, signal),
        )
      : this.processAttempt(turn, signal);
  }
  async processAttempt(turn, signal) {
    let queries = [];
    try {
      if (this.service.started(turn.id) === false) return;
      await this.context?.prepare(turn, signal);
      signal.throwIfAborted();
      if (this.stopping) return;
      const plan = await withRequestDeadline(
        (requestSignal) =>
          this.planner.plan(turn, this.service.context(turn), requestSignal, (trace) => {
            queries = trace;
          }),
        signal,
        this.timeoutMs,
        "planning-timeout",
      );
      queries = plan.queries;
      if (this.stopping) return;
      this.afterProposal(turn);
      this.service.apply(turn, plan.proposal, plan.queries);
    } catch (error) {
      if (!this.stopping) this.service.failed(turn, error, error.queries ?? queries);
    }
  }
  async suspend() {
    this.stopping = true;
    this.controller?.abort();
    if (this.task) await this.task;
  }
}
