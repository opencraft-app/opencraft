import { digest } from "../domain/values.mjs";
import { workOrigin } from "../domain/notification-policy.mjs";

/** Owns background notification selection, deduplication and batching, never result acceptance. */
export class NotificationService {
  constructor({
    repository,
    uow,
    readWork,
    history,
    attention,
    now = Date.now,
  }) {
    Object.assign(this, { repository, uow, readWork, history, attention, now });
  }
  accepted(delivery) {
    if (delivery.suppress_notification) return;
    const origin = workOrigin(this.readWork(delivery.work_id));
    if (origin.kind === "direct") {
      this.history.result(delivery);
      if (this.history.destinations(delivery.work_id).length)
        this.attention.notified();
      return;
    }
    const key = origin.key ?? `${origin.kind}:${delivery.work_id}`;
    const hash = digest(
      delivery.user_message_json
        ? [delivery.text, delivery.user_message_json]
        : delivery.text,
    );
    const existing = this.repository.get(delivery.id);
    if (existing) return;
    const suppress =
      origin.notify === "never" ||
      (origin.notify === "changed" &&
        this.repository.latest(key)?.content_hash === hash);
    for (const conversationId of this.history.destinations(delivery.work_id))
      this.repository.add({
        id: `${delivery.id}:${conversationId}`,
        deliveryId: delivery.id,
        conversationId,
        key,
        hash,
        workId: delivery.work_id,
        text: delivery.text,
        userMessageJson: delivery.user_message_json,
        state: suppress ? "suppressed" : "pending",
        at: this.now(),
      });
  }
  flush() {
    const due = this.repository.pending(this.now() - 250);
    if (!due.length) return;
    this.uow.transaction(() => {
      const groups = new Map();
      for (const notice of due) {
        const key = `${notice.conversation_id}:${notice.origin_key}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(notice);
      }
      for (const notices of groups.values()) {
        for (let i = 0; i < notices.length; i += 8) {
          const batch = notices.slice(i, i + 8);
          this.history.batch(batch);
          this.attention.notified();
          for (const notice of batch) this.repository.sent(notice.id);
        }
      }
    });
  }
}
