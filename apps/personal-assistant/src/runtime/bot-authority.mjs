import { withRequestDeadline } from "../adapters/local/request-deadline.mjs";
import { assertBotBinding, botBinding } from "../domain/bot-binding.mjs";

/** Cached expiring host authority, not an ownership registry. Network refresh never enters a UoW. */
export class BotAuthority {
  constructor(binding, port, { now = Date.now } = {}) {
    this.binding = botBinding(binding);
    this.port = port;
    this.now = now;
    this.controller = new AbortController();
    this.lease = null;
    this.pending = null;
    this.retired = false;
  }
  assertCurrent() {
    if (this.retired || !this.lease || this.lease.expiresAt <= this.now())
      throw Error("Bot authority unavailable or retired");
  }
  refresh() {
    if (this.retired) return Promise.reject(Error("Bot authority retired"));
    return (this.pending ??= (async () => {
      const lease = await withRequestDeadline(
        (signal) => this.port.authorize(this.binding, signal),
        this.controller.signal,
        5000,
      );
      this.controller.signal.throwIfAborted();
      assertBotBinding(lease?.binding, this.binding);
      if (
        typeof lease.epoch !== "string" ||
        !lease.epoch ||
        !Number.isSafeInteger(lease.expiresAt) ||
        lease.expiresAt <= this.now()
      )
        throw Error("Invalid Bot authority lease");
      if (this.epoch && this.epoch !== lease.epoch) {
        this.retired = true;
        throw Error("Bot authority epoch retired");
      }
      this.epoch = lease.epoch;
      this.lease = Object.freeze({ ...lease });
      return this.lease;
    })()
      .catch((error) => {
        this.lease = null;
        throw error;
      })
      .finally(() => {
        this.pending = null;
      }));
  }
  async close() {
    this.retired = true;
    this.controller.abort();
    await this.pending?.catch(() => {});
  }
}
