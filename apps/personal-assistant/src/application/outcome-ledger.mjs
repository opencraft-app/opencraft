import { requireText, stable } from "../domain/values.mjs";

/** Sole writer of immutable Results and mutable Delivery obligations. Never re-executes work. */
export class OutcomeLedger {
  constructor(repository, now = Date.now) {
    this.repository = repository;
    this.now = now;
  }
  record(work, execution, message, options = {}) {
    requireText(message, "result", 1000000);
    const resultId = `result:${execution.id}`,
      deliveryId = `delivery:${execution.id}:mailbox`;
    const old = this.repository.results(work.id).find((r) => r.id === resultId);
    if (old) {
      if (old.text !== message) throw new Error("Immutable result identity reused");
      const delivery = this.repository.deliveriesFor(work.id).find((d) => d.id === deliveryId);
      if (
        (delivery.message_text ?? message) !== (options.deliveryText ?? message) ||
        !!delivery.suppress_notification !== !!options.suppressNotification ||
        (delivery.user_message_json ?? null) !== (options.userMessage ? stable(options.userMessage) : null)
      )
        throw new Error("Immutable delivery decision reused");
      return { resultId, deliveryId, existing: true };
    }
    this.repository.addResult({
      id: resultId,
      executionId: execution.id,
      workId: work.id,
      revision: work.revision,
      text: message,
      at: this.now(),
    });
    this.repository.addDelivery({
      id: deliveryId,
      resultId,
      workId: work.id,
      revision: work.revision,
      messageText: options.deliveryText,
      userMessage: options.userMessage,
      suppressNotification: options.suppressNotification,
    });
    return { resultId, deliveryId, existing: false };
  }
  withdraw(workId) {
    this.repository.withdraw(workId);
  }
  pending() {
    return this.repository.pending(this.now());
  }
  accepted(delivery) {
    const current = this.repository.deliveriesFor(delivery.work_id).find((d) => d.id === delivery.id);
    if (!current || current.status !== "pending") return false;
    this.repository.accepted(delivery.id, this.now());
    return true;
  }
  failed(delivery, error) {
    this.repository.failed(delivery.id, this.now() + Math.min(30000, 250 * 2 ** Math.min(delivery.attempts, 7)), error);
  }
}
