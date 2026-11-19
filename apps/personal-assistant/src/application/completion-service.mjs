import { createHash } from "node:crypto";
import { CompletionContract } from "../domain/completion-contract.mjs";
import { digest, requireText } from "../domain/values.mjs";

/** Records host I/O receipts and evaluates contracts. No model-callable "mark completed" command exists. */
export class CompletionService {
  constructor({ uow, repositories: r, works, executions, ledger, now = Date.now }) {
    Object.assign(this, { uow, r, works, executions, ledger, now });
  }
  publishedNote(work, artifact, body) {
    requireText(body, "note", 100000);
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (artifact.sha256 !== sha256) throw new Error("Artifact receipt does not match published bytes");
    requireText(artifact.path, "artifact path");
    return this.uow.transaction(() => {
      this.works.assertCurrent(work);
      const contract = CompletionContract.forWork(this.works.require(work.id).record),
        executionId = this.executions.get(work).id;
      return this.ledger.record({
        id: `evidence:${executionId}:note`,
        executionId,
        kind: "note.published",
        at: this.now(),
        data: {
          path: artifact.path,
          sha256,
          literalMatches: contract.checks
            .filter((c) => c.kind === "note_contains" && body.includes(c.text))
            .map((c) => c.id),
        },
      });
    });
  }
  materialRead(work, material) {
    requireText(material.path, "material path");
    if (!/^[a-f0-9]{64}$/.test(material.sha256)) throw new Error("Material evidence needs a SHA256");
    return this.uow.transaction(() => {
      this.works.assertCurrent(work);
      const executionId = this.executions.get(work).id;
      return this.ledger.record({
        id: `evidence:${executionId}:read:${digest([material.source, material.path, material.sha256])}`,
        executionId,
        kind: "material.read",
        at: this.now(),
        data: {
          source: material.source,
          path: material.path,
          sha256: material.sha256,
        },
      });
    });
  }
  platformRead(work, receipt) {
    return this.uow.transaction(() => {
      this.works.assertCurrent(work);
      const executionId = this.executions.get(work).id;
      // Host-produced I/O metadata, never model prose or duplicated group messages.
      const data = {
        query: receipt.query,
        ok: receipt.ok,
        observedAt: receipt.observedAt,
        ...(receipt.ok ? { coverage: receipt.coverage } : { failure: receipt.failure }),
      };
      return this.ledger.record({
        id: `evidence:${executionId}:platform:${digest(data)}`,
        executionId,
        kind: "platform.read",
        at: this.now(),
        data,
      });
    });
  }
  platformReadEvidence(executionId) {
    const all = this.ledger.evidence(executionId).filter((e) => e.kind === "platform.read");
    return {
      items: all.slice(-20).map((e) => e.data),
      total: all.length,
      omitted: all.length > 20,
      coverage: "bounded-current-execution",
    };
  }
  assess(work, result) {
    const current = this.works.assertCurrent(work),
      executionId = this.executions.get(work).id,
      contract = CompletionContract.forWork(current);
    const data = CompletionContract.evaluate(contract, this.ledger.evidence(executionId), result);
    return this.ledger.assess({
      executionId,
      workId: work.id,
      revision: work.revision,
      data,
      at: this.now(),
    }).data;
  }
  detail(workId) {
    return this.r.executions.list(workId).map((e) => ({
      executionId: e.id,
      evidence: this.ledger.evidence(e.id),
      assessment: this.ledger.assessment(e.id),
    }));
  }
}
