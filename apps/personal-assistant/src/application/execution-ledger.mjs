import { stable } from "../domain/values.mjs";

/** Sole writer of business execution bindings. Native Pi execution state is outside this ledger. */
export class ExecutionLedger {
  constructor(repository, harness = "pi") {
    if (!["pi", "codex"].includes(harness))
      throw new Error("Unknown execution harness");
    this.harness = harness;
    this.repository = repository;
  }
  get(work) {
    return this.repository.get(work);
  }
  create(workId, revision, inputId, request = null) {
    const id = `${workId}:r${revision}`;
    this.repository.add({
      id,
      workId,
      revision,
      inputId,
      request,
      harness: this.harness,
    });
    return id;
  }
  continue(work, inputId, request) {
    const previous = this.get(work);
    const attempt = previous.attempt + 1;
    const id = `${work.id}:r${work.revision}:a${attempt}`;
    this.repository.add({
      id,
      workId: work.id,
      revision: work.revision,
      inputId,
      request,
      harness: previous.harness,
      attempt,
      predecessorId: previous.id,
      sessionRoot: previous.session_root ?? previous.id,
    });
    this.repository.inherit(id, previous);
    this.repository.scheduleDirectives(work.id, work.revision, id);
    return id;
  }
  acceptDirective(value) {
    this.repository.addDirective(value);
  }
  directives(workId, state) {
    return this.repository.directives(workId, state);
  }
  contextDirectives(work) {
    const rows = this.repository.contextDirectives(
      work.id,
      work.revision,
      this.get(work).id,
    );
    const items = [];
    let characters = 0,
      omitted = rows.length > 32;
    for (const row of rows.slice(0, 32)) {
      if (characters + row.text.length > 24000) {
        omitted = true;
        continue;
      }
      items.push({ id: row.id, seq: row.seq, text: row.text });
      characters += row.text.length;
    }
    return { items: items.reverse(), omitted };
  }
  submittedDirectives(execution) {
    this.repository.submittedDirectives(execution.id);
  }
  predecessor(execution) {
    return execution.predecessor_id
      ? (this.repository.priorBinding(execution) ??
          this.repository.byId(execution.predecessor_id))
      : null;
  }
  retire(workId, reason) {
    if (!["cancelled", "superseded"].includes(reason))
      throw new Error("Invalid retirement reason");
    this.repository.retire(workId, reason);
    this.repository.retireDirectives(workId);
  }
  mark(work, status) {
    if (!["running", "blocked", "succeeded", "reported"].includes(status))
      throw new Error("Invalid execution observation");
    const execution = this.get(work);
    if (!execution) throw new Error("Unknown business execution");
    if (["cancelled", "superseded"].includes(execution.status))
      throw new Error("Execution no longer owns this work");
    this.repository.status(execution.id, status);
  }
  report(work) {
    return this.repository.report(this.get(work).id);
  }
  recordReport(work, text, error, at) {
    if (typeof text !== "string" || text.length > 1000000)
      throw new Error("Execution report must be bounded text");
    const execution = this.get(work);
    if (!execution) throw new Error("Unknown business execution");
    const value = {
      id: `report:${execution.id}`,
      execution_id: execution.id,
      work_id: work.id,
      revision: work.revision,
      status: error == null ? "returned" : "error",
      text,
      error: error == null ? null : String(error).slice(0, 2000),
      created_at: at,
    };
    const old = this.report(work);
    if (old) {
      if (
        old.text !== value.text ||
        old.error !== value.error ||
        old.status !== value.status
      )
        throw new Error("Immutable execution report identity reused");
      return { report: old, duplicate: true };
    }
    this.repository.addReport(value);
    return { report: value, duplicate: false };
  }
  guard(work, value) {
    this.repository.guard(this.get(work).id, value);
  }
  snapshot(execution, value) {
    if (execution.context_json && execution.context_json !== stable(value))
      throw new Error("Execution context is immutable");
    this.repository.context(execution.id, value);
  }
  bind(execution, conversationId, submissionId) {
    if ((conversationId?.engine ?? "pi") !== execution.harness)
      throw new Error(
        "Native engine differs from the immutable execution harness",
      );
    if (
      execution.conversation_id &&
      execution.conversation_id !== JSON.stringify(conversationId)
    )
      throw new Error("Execution conversation binding changed");
    if (
      execution.submission_id &&
      execution.submission_id !== JSON.stringify(submissionId)
    )
      throw new Error("Execution submission binding changed");
    this.repository.bind(execution.id, conversationId, submissionId);
  }
}
