import { stable } from "../domain/values.mjs";

/** Sole writer of execution evidence and completion assessments; never writes native checkpoints. */
export class CompletionLedger {
  constructor(repository) {
    this.repository = repository;
  }
  record(receipt) {
    const existing = this.repository
      .evidence(receipt.executionId)
      .find((e) => e.id === receipt.id);
    if (existing) {
      if (stable(existing.data) !== stable(receipt.data))
        throw new Error("Immutable completion evidence reused");
      return existing;
    }
    this.repository.addEvidence(receipt);
    return receipt;
  }
  assess(assessment) {
    const existing = this.repository.assessment(assessment.executionId);
    if (existing) {
      if (stable(existing.data) !== stable(assessment.data))
        throw new Error("Immutable completion assessment reused");
      return existing;
    }
    this.repository.addAssessment(assessment);
    return assessment;
  }
  evidence(id) {
    return this.repository.evidence(id);
  }
  assessment(id) {
    return this.repository.assessment(id);
  }
}
