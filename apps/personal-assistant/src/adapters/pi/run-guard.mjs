import { performance } from "node:perf_hooks";
import { RunLimitError } from "../../domain/run-policy.mjs";

/** Native abort stays with Pi. Only local policy and cancellation handles live here. */
export class PiRunGuard {
  constructor({ policy, step }) {
    Object.assign(this, { policy, step });
    this.error = null;
  }
  start(root) {
    this.root = root;
    this.startedAt = performance.now();
    this.timer = setTimeout(
      () =>
        this.stop(new RunLimitError("work-timeout", this.policy.workTimeoutMs)),
      this.policy.workTimeoutMs,
    );
    this.timer.unref?.();
  }
  abort() {
    if (!this.abortTask && this.root) {
      this.abortTask = this.root.abort();
      // The adapter later awaits it. Register rejection handling before the task can reject.
      this.abortTask.catch(() => {});
    }
  }
  stop(error) {
    this.error ??= error;
    this.abort();
  }
  async beforeRequest(_request, api) {
    try {
      if (this.error) throw this.error;
      this.step(api.taskId);
    } catch (error) {
      // Pi 1.3 reports and swallows ordinary hook errors. Native abort must signal
      // this invocation before the hook throws, or Pi would still send a request.
      const cancelled = new Promise((resolve) => {
        if (api.signal.aborted) resolve();
        else api.signal.addEventListener("abort", resolve, { once: true });
      });
      this.stop(error);
      await cancelled;
      throw error;
    }
  }
  beforeTool(_call, api) {
    if (this.error || api.signal.aborted)
      return { block: this.error?.message ?? "Execution was stopped" };
  }
  pause() {
    clearTimeout(this.timer);
    if (this.elapsedMs === undefined && this.startedAt !== undefined)
      this.elapsedMs = performance.now() - this.startedAt;
  }
  async close() {
    this.pause();
    if (this.abortTask) await this.abortTask;
  }
}
