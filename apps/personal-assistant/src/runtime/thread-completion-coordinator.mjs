import { withRequestDeadline } from "../adapters/local/request-deadline.mjs";
import { parseInputCompletion } from "@opencraft/appserver-protocol/input-completion";
/** Temporary I/O only; links, provisional answers and report dedupe belong to Execution. */
export class ThreadCompletionCoordinator {
  constructor({
    app,
    command,
    settle,
    assertOwner,
    onError = () => {},
    now = Date.now,
  }) {
    Object.assign(this, { app, command, settle, assertOwner, onError, now });
    this.nextAt = 0;
    this.stopping = false;
  }
  tick() {
    if (this.stopping || this.running || this.now() < this.nextAt) return;
    if (
      !this.app.executions.threads.pending().length &&
      !this.app.executions.threads.readyReports().length
    )
      return;
    this.controller = new AbortController();
    this.running = this.reconcile(this.controller.signal)
      .catch((error) => {
        if (!this.stopping) this.onError(error);
      })
      .finally(() => {
        this.running = null;
        this.nextAt = this.now() + 2000;
      });
  }
  current(row) {
    this.assertOwner();
    const work = this.app.workRecord(row.work_id);
    if (
      work.revision !== row.revision ||
      work.active_execution_id !== row.execution_id ||
      !["queued", "running"].includes(work.status) ||
      !this.app.executions.ready(work)
    )
      return null;
    try {
      this.app.executions.assertThreadAction(work);
    } catch {
      // Local scope no longer matches this immutable delegation. Do not call
      // the platform with a new binding or strand a held Work in scheduler slots.
      // Owner fencing remains outside this catch; a retired writer cannot commit.
      this.app.executions.blocked(
        work,
        "Platform Thread authority changed; review or revise this Work before continuing. No replacement task was started.",
      );
      return null;
    }
    return work;
  }
  async reconcile(signal) {
    // Bounded batch; each command uses the original Work identity and Core authority.
    const batch = this.app.executions.threads.pending(this.afterRowid ?? 0);
    if (!batch.length) batch.push(...this.app.executions.threads.pending());
    for (const link of batch) {
      this.afterRowid = link.scan_id;
      signal.throwIfAborted();
      let work = this.current(link);
      if (!work) continue;
      try {
        // A lost acceptance reply replays only the original idempotent intent.
        const result = await withRequestDeadline(
          (ioSignal) =>
            this.command(
              link.operation_id
                ? ["thread", "operation", "show", link.operation_id]
                : this.app.executions.threads.argv(link),
              work.id,
              ioSignal,
            ),
          signal,
          15000,
          "thread-observation-timeout",
        );
        signal.throwIfAborted();
        work = this.current(link);
        if (!work) continue;
        if (link.operation_id) {
          if (result.input?.completion) {
            const completion = parseInputCompletion(
              result.input.completion,
              result.input.targetTurnId ?? null,
            );
            if (!completion)
              throw Error(
                "Platform completion does not match the admitted Turn",
              );
            result.input = { ...result.input, completion };
          }
          this.app.executions.threads.observe(work, link, result);
        } else this.app.executions.threads.accepted(work, link, result);
      } catch (error) {
        if (signal.aborted) throw error;
        work = this.current(link);
        if (!work) continue;
        if (
          [401, 403].includes(Number(error.status)) ||
          /assistant_thread_(grant_revoked|source_unavailable|denied|user_control)|personal_assistant_(unclaimed|revoked)/.test(
            String(error.code ?? error.message),
          )
        )
          this.app.executions.threads.denied(work, link);
        else if (
          [400, 409].includes(Number(error.status)) ||
          /assistant_thread_(not_running|turn_changed|profile_required|profile_unavailable|host_unsupported)|invalid_thread_argument|idempotency_conflict/.test(
            String(error.code ?? error.message),
          )
        )
          this.app.executions.threads.refused(work, link);
        else this.onError(error); // Unknown effects remain unresolved, never resubmitted with a new key.
      }
    }
    const reports = this.app.executions.threads.readyReports(
      this.reportAfterRowid ?? 0,
    );
    if (!reports.length)
      reports.push(...this.app.executions.threads.readyReports());
    for (const answer of reports) {
      this.reportAfterRowid = answer.scan_id;
      signal.throwIfAborted();
      const work = this.current(answer);
      if (work) this.settle(work, answer.text, answer.error);
    }
  }
  async close() {
    this.stopping = true;
    this.controller?.abort();
    await this.running;
  }
}
