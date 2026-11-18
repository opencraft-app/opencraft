/** Coordinates result/receipt settlement through the owning ledgers and WorkService. */
export class OutcomeService {
  constructor({
    uow,
    repositories: r,
    works,
    history,
    notifications,
    ledger,
    executions,
    completion,
    ready = () => true,
    inputsValid = () => true,
    now = Date.now,
  }) {
    Object.assign(this, {
      uow,
      r,
      works,
      history,
      notifications,
      ledger,
      executions,
      completion,
      ready,
      inputsValid,
      now,
    });
  }
  deliverable(delivery) {
    const work = this.works.require(delivery.work_id).record;
    return (
      work.status !== "cancelled" &&
      work.revision === delivery.revision &&
      delivery.result_id === `result:${work.active_execution_id}` &&
      this.inputsValid(work)
    );
  }
  record(work, message, options = {}) {
    return this.uow.transaction(() => {
      this.works.assertCurrent(work);
      if (!this.ready(work))
        throw new Error("Goal paused or dependency no longer valid");
      const assessment = this.completion.assess(work, message);
      if (!assessment.passed) {
        const error =
          "Completion checks not satisfied: " +
          assessment.checks
            .filter((c) => !c.passed)
            .map((c) => c.id)
            .join(", ") +
          (assessment.resultPresent ? "" : " (empty result)");
        this.executions.mark(work, "blocked");
        this.works.blocked(work, error);
        this.history.completionBlocked(work, assessment);
        this.r.events.append(
          "completion.failed",
          work.id,
          { revision: work.revision, assessment },
          this.now(),
        );
        return { accepted: false, assessment };
      }
      if (options.userMessage)
        this.history.prepareMessage(
          options.userMessage,
          this.history.destinations(work.id)[0],
        );
      const { resultId, deliveryId, existing } = this.ledger.record(
        work,
        this.executions.get(work),
        message,
        options,
      );
      if (!existing) {
        this.executions.mark(work, "succeeded");
        this.works.resultReady(work);
        this.r.events.append(
          "result.saved",
          work.id,
          { resultId, deliveryId },
          this.now(),
        );
      }
      return { resultId, deliveryId, accepted: true, assessment };
    });
  }
  pending() {
    return this.ledger.pending().filter((item) => this.deliverable(item));
  }
  accepted(delivery) {
    this.uow.transaction(() => {
      if (!this.deliverable(delivery) || !this.ledger.accepted(delivery))
        return;
      this.works.delivered(delivery.work_id, delivery.revision);
      this.notifications.accepted(delivery);
      this.r.events.append(
        "delivery.accepted",
        delivery.work_id,
        { deliveryId: delivery.id, destination: "local-mailbox" },
        this.now(),
      );
    });
  }
  failed(delivery, error) {
    this.ledger.failed(delivery, error);
  }
}
