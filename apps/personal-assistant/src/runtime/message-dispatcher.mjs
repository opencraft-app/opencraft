import { withRequestDeadline } from "../adapters/local/request-deadline.mjs";
/** One transport operation at a time; persistent pending identity stays with MessageService. */
export class MessageDispatcher {
  constructor(service, transport, onError = () => {}, assertWriter = () => {}) {
    Object.assign(this, { service, transport, onError, assertWriter });
    this.task = null;
    this.stopping = false;
  }
  tick() {
    if (this.stopping || this.task) return;
    const message = this.service.pending()[0];
    if (!message) return;
    this.controller = new AbortController();
    this.task = Promise.resolve()
      .then(() =>
        withRequestDeadline(
          (signal) => {
            this.assertWriter();
            return this.transport.deliver(message, signal);
          },
          this.controller.signal,
          15000,
        ),
      )
      .then((receipt) => this.service.accepted(message, receipt))
      .catch((error) => {
        try {
          this.service.failed(
            message,
            error?.code === "RUN_LIMIT_MODEL_TIMEOUT"
              ? new Error(
                  "User message transport timed out; acceptance is unknown",
                )
              : error,
          );
        } catch (failure) {
          this.onError(failure);
        }
      })
      .finally(() => {
        this.task = null;
      });
  }
  async close() {
    this.stopping = true;
    this.controller?.abort();
    if (this.task) await this.task;
  }
}
