import { withRequestDeadline } from "../adapters/local/request-deadline.mjs";
/** One ephemeral model request; all proposals/retries/evidence live with the service. */
export class MemoryLearningCoordinator {
  constructor(service, model, onError = () => {}, { timeoutMs = 90000, telemetry } = {}) {
    Object.assign(this, { service, model, onError, timeoutMs, telemetry });
    this.task = null;
    this.stopping = false;
  }
  tick() {
    if (this.stopping || this.task) return;
    this.service.queueTemporal?.();
    const [job] = this.service.pending();
    if (!job) return;
    this.controller = new AbortController();
    this.task = this.process(job, this.controller.signal)
      .catch(this.onError)
      .finally(() => {
        this.task = null;
      });
  }
  async process(job, signal) {
    return this.telemetry
      ? this.telemetry.run("memory.prepare", { "app.phase": "learning", "app.batch_attempts": job.attempts ?? 0 }, () =>
          this.processAttempt(job, signal),
        )
      : this.processAttempt(job, signal);
  }
  async processAttempt(job, signal) {
    try {
      await withRequestDeadline(
        async (attemptSignal) => {
          signal = attemptSignal;
          if (job.state === "queued") {
            const raw = await withRequestDeadline(
              (requestSignal) =>
                this.model.propose(
                  structuredClone({
                    evidence: job.evidence,
                    snapshot: job.snapshot,
                    today: job.today,
                    temporal: !!job.temporal,
                  }),
                  requestSignal,
                ),
              signal,
              this.timeoutMs,
            );
            signal.throwIfAborted();
            if (this.stopping) return;
            job = this.service.proposed(job.id, raw);
          }
          const verification = job.proposal.changes.length
            ? await withRequestDeadline(
                (requestSignal) =>
                  this.model.verify(
                    structuredClone({
                      evidence: job.evidence,
                      snapshot: job.snapshot,
                      today: job.today,
                      temporal: !!job.temporal,
                      proposal: job.proposal,
                    }),
                    requestSignal,
                  ),
                signal,
                this.timeoutMs,
              )
            : { approved: true };
          signal.throwIfAborted();
          if (!this.stopping) this.service.finish(job.id, verification);
        },
        signal,
        this.timeoutMs,
      );
    } catch (error) {
      this.telemetry?.event("memory.prepare.failed", {
        "app.outcome": signal?.aborted ? "aborted" : "error",
      });
      if (!this.stopping) this.service.failed(job.id, error);
    }
  }
  async suspend() {
    this.stopping = true;
    this.controller?.abort();
    if (this.task) await this.task;
  }
}
