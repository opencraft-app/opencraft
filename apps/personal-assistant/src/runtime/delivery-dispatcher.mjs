/** Retries delivery only; it never starts an execution or asks a model to regenerate a result. */
export class DeliveryDispatcher {
  constructor(app, delivery, assertWriter = () => {}) {
    this.assertWriter = assertWriter;
    this.app = app;
    this.delivery = delivery;
  }
  tick() {
    for (const item of this.app.outcomes.pending()) {
      const work = this.app.works.require(item.work_id).record;
      if (work.status === "cancelled" || work.revision !== item.revision) continue;
      try {
        this.assertWriter();
        this.delivery.deliver(item);
        this.app.outcomes.accepted(item);
      } catch (error) {
        this.app.outcomes.failed(item, error);
      }
    }
  }
}
