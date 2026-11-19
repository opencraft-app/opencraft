/** Sole writer of Interaction records. An answered request remains replay-readable. */
export class InteractionLedger {
  constructor(repository) {
    this.repository = repository;
  }
  get(id) {
    return this.repository.get(id);
  }
  open(record) {
    const old = this.get(record.id);
    if (old) {
      if (
        (old.kind ?? "question") !== record.kind ||
        (old.metadata_json === "{}" || !old.metadata_json
          ? JSON.stringify({ provider: "local" })
          : old.metadata_json) !== record.metadata_json ||
        old.question !== record.question ||
        old.execution_id !== record.execution_id
      )
        throw new Error("Interaction identity reused with different intent");
      return old;
    }
    this.repository.add(record);
    return record;
  }
  save(record) {
    this.repository.save(record);
  }
  rejectPending(workId, revision, inputId, now) {
    this.repository.rejectPending(workId, revision, inputId, now);
  }
  retire(workId, reason, { preserveAnswers = false } = {}) {
    if (!["cancelled", "superseded"].includes(reason)) throw new Error("Invalid interaction retirement");
    this.repository.retire(workId, reason, preserveAnswers);
  }
}
