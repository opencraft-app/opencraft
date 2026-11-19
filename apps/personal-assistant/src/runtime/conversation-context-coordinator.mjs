import { withRequestDeadline } from "../adapters/local/request-deadline.mjs";
import { CONTEXT_POLICY } from "../domain/conversation-context.mjs";

/** One bounded pure-model update before a reception turn; no parallel queue or business state here. */
export class ConversationContextCoordinator {
  constructor(
    service,
    model,
    {
      timeoutMs = CONTEXT_POLICY.timeoutMs,
      afterProposal = () => {},
      afterCommit = () => {},
      onError = () => {},
      telemetry,
    } = {},
  ) {
    Object.assign(this, {
      service,
      model,
      timeoutMs,
      afterProposal,
      afterCommit,
      onError,
      telemetry,
    });
  }
  async prepare(turn, signal) {
    return this.telemetry
      ? this.telemetry.run("context.prepare", { "app.phase": "summary" }, () => this.prepareAttempt(turn, signal))
      : this.prepareAttempt(turn, signal);
  }
  async prepareAttempt(turn, signal) {
    let job;
    try {
      job = this.service.capture(turn);
      if (!job || !this.service.begin(job)) return;
      const proposal = await withRequestDeadline(
        (s) => this.model.summarize(JSON.parse(job.source_json), s),
        signal,
        this.timeoutMs,
      );
      signal.throwIfAborted();
      this.afterProposal();
      this.service.commit(job, proposal);
      this.afterCommit();
    } catch (error) {
      if (job && !signal.aborted) this.service.failed(job, error);
      if (signal.aborted) throw error;
      this.onError(error);
    }
  }
}
