import { requireText, requireRevision } from "./values.mjs";
import { CompletionContract } from "./completion-contract.mjs";

export class WorkItem {
  constructor(record) {
    if (!record) throw new Error("Unknown work");
    this.record = { ...record };
  }
  assertCurrent(expected) {
    if (this.record.revision !== expected.revision || this.record.status === "cancelled")
      throw new Error("Work was cancelled or superseded");
  }
  amend(text, expectedRevision, now, completion) {
    requireText(text, "text");
    requireRevision(expectedRevision, this.record.revision, "work");
    if (this.record.status === "cancelled") throw new Error("Cancelled work cannot be resumed by amend");
    return {
      ...this.record,
      text,
      revision: this.record.revision + 1,
      status: "queued",
      error: null,
      updated_at: now,
      completion_json: JSON.stringify(
        CompletionContract.create(text, completion ?? CompletionContract.forWork(this.record)),
      ),
    };
  }
  cancel(now) {
    if (this.record.status === "completed") return { ...this.record };
    return { ...this.record, status: "cancelled", updated_at: now };
  }
  started(now) {
    return { ...this.record, status: "running", updated_at: now };
  }
  waitForInput(now) {
    if (!["queued", "running", "waiting_input"].includes(this.record.status))
      throw new Error("Work cannot request input in its current state");
    return { ...this.record, status: "waiting_input", updated_at: now };
  }
  resumeInput(now) {
    if (this.record.status !== "waiting_input") throw new Error("Work is not waiting for input");
    return { ...this.record, status: "queued", error: null, updated_at: now };
  }
  resultReady(now) {
    if (!["queued", "running", "awaiting_review"].includes(this.record.status))
      throw new Error("Work cannot accept another result in its current state");
    return {
      ...this.record,
      status: "awaiting_delivery",
      error: null,
      updated_at: now,
    };
  }
  awaitingReview(now) {
    if (!["queued", "running"].includes(this.record.status))
      throw new Error("Work cannot receive a new execution report");
    return { ...this.record, status: "awaiting_review", updated_at: now };
  }
  delivered(revision, now) {
    if (revision !== this.record.revision || this.record.status !== "awaiting_delivery") return { ...this.record };
    return { ...this.record, status: "completed", updated_at: now };
  }
}
