import type { DshEvent } from "./dsh-client.js";
import { DshExecutionRecord } from "./dsh-execution-record.js";

/** One imported HyperNode execution record owns both live and history Items. */
export class DshTurnProjection {
  readonly execution: DshExecutionRecord;
  constructor(readonly sessionId: string, readonly turnId: string, cwd: string) {
    this.execution = new DshExecutionRecord(sessionId, turnId, cwd);
  }
  get terminalOutcome() {
    if (!this.execution.ended) return null;
    const turn = this.execution.snapshot();
    return { status: turn.status, error: turn.error };
  }
  project(event: DshEvent) {
    const events = this.execution.project(event);
    return {
      events,
      started: events.filter(e => e.method === "item/started").map(e => e.params.item),
      completed: events.filter(e => e.method === "item/completed").map(e => e.params.item),
      notifications: events.filter(e => !["item/started", "item/completed"].includes(e.method)),
    };
  }
}
