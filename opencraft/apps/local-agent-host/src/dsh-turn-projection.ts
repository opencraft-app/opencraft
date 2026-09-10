import type { DshEvent } from "./dsh-client.js";
import { DshToolProjection } from "./dsh-tool-projection.js";
type Value = Record<string, any>;

/** One ordered fold for both live presentation and history reconstruction. */
export class DshTurnProjection {
  private readonly tools: DshToolProjection;
  private pending: Value[] = [];
  constructor(readonly sessionId: string, readonly turnId: string, cwd: string) { this.tools = new DshToolProjection(cwd); }
  project(event: DshEvent, baseItems: Value[] = []) {
    const data = (event.data ?? {}) as Value;
    const completed: Value[] = [];
    const started: Value[] = [];
    const notifications: Array<{ method: string; params: Value }> = [];
    const flush = (phase: string) => { completed.push(...this.pending.map(item => ({ ...item, phase }))); this.pending = []; };
    if (["step/start", "tool/call", "user/message"].includes(event.type)) flush("commentary");
    if (event.type === "assistant/message") {
      flush("commentary");
      this.pending = baseItems.filter(item => item.type === "agentMessage");
      completed.push(...baseItems.filter(item => item.type !== "agentMessage"));
      if (data.message?.content?.some((block: Value) => block.type === "tool-call")) flush("commentary");
    } else completed.push(...baseItems);
    const toolItems = this.tools.project(this.sessionId, event);
    if (event.type === "tool/call") started.push(...toolItems);
    else completed.push(...toolItems);
    for (const item of toolItems) if (item.type === "commandExecution" && item.status !== "inProgress" && item.aggregatedOutput) {
      notifications.push({ method: "item/commandExecution/outputDelta", params: { threadId: this.sessionId, turnId: this.turnId, itemId: item.id, delta: item.aggregatedOutput } });
    }
    if (event.type === "todo/write") {
      const plan = (Array.isArray(data.todos) ? data.todos : []).map((todo: Value) => ({
        step: todo.content, status: todo.status === "completed" ? "completed" : ["in_progress", "inProgress", "active"].includes(todo.status) ? "inProgress" : "pending",
      })).filter((todo: Value) => typeof todo.step === "string" && todo.step.length > 0);
      // Materialize the same todo-list item once for live events and history.
      // A todo observation is not a written plan proposal. Emitting both a
      // plan notification and this item would also render the observation twice.
      completed.push({ type: "todo-list", id: `dsh-todo-${this.turnId}-${event.seq}`, explanation: null, plan });
    }
    if (event.type === "turn/end") {
      const reason = typeof data.reason === "string" ? data.reason : data.reason?.kind;
      flush(["failed", "error", "cancelled", "interrupted"].includes(reason) ? "commentary" : "final_answer");
      completed.push(...this.tools.settle(event.time, ["cancelled", "interrupted"].includes(reason)));
    }
    return { started, completed, notifications };
  }
  snapshotPending(): Value[] { return this.pending.map(item => ({ ...item, phase: null })); }
}
