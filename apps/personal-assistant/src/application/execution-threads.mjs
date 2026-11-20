import {
  parseThreadCommand,
  replaceThreadCommandIdempotencyKey,
} from "@opencraft/appserver-protocol/thread-command";
import { stable, requireText, digest } from "../domain/values.mjs";

/** Execution-owned links to existing platform operations, never a native task queue. */
export class ExecutionThreadLinks {
  constructor({ uow, repository, execution, check, ready }) {
    Object.assign(this, { uow, repository, execution, check, ready });
  }
  prepare(work, command, argv) {
    if (!["start", "tell"].includes(command.command)) return null;
    return this.uow.transaction(() => {
      this.check(work);
      const execution = this.execution(work),
        id = digest(command.idempotencyKey);
      const old = this.repository.threadLink(execution.id, id),
        encoded = stable(argv);
      if (old) {
        if (old.argv_json !== encoded)
          throw Error(
            "Platform operation identity reused with different intent",
          );
        return old;
      }
      if (this.repository.threadLinks(execution.id).length >= 64)
        throw Error("Platform delegation bound exceeded");
      this.repository.addThreadLink(execution.id, id, encoded);
      return this.repository.threadLink(execution.id, id);
    });
  }
  argv(link) {
    const argv = JSON.parse(link.argv_json),
      command = parseThreadCommand(argv);
    return replaceThreadCommandIdempotencyKey(
      argv,
      "execution:" + digest([link.execution_id, command.idempotencyKey]),
    );
  }
  accepted(work, link, receipt) {
    if (!link) return;
    return this.uow.transaction(() => {
      this.check(work);
      requireText(receipt?.operationId, "platform operation", 256);
      if (receipt.workId !== work.id)
        throw Error("Platform receipt belongs to another Work");
      const current = this.repository.threadLink(
        this.execution(work).id,
        link.id,
      );
      if (!current) throw Error("Platform receipt has no recorded intent");
      if (current.operation_id && current.operation_id !== receipt.operationId)
        throw Error("Platform operation identity changed");
      this.repository.bindThreadLink(
        current.execution_id,
        current.id,
        receipt.operationId,
      );
      if (receipt.state === "rejected")
        this.repository.settleThreadLink(current.execution_id, current.id, {
          status: "rejected",
          text: "The platform rejected this task before submission.",
        });
      return receipt;
    });
  }
  pending(after = 0) {
    return this.repository.pendingThreadLinks(after);
  }
  observe(work, link, operation) {
    return this.uow.transaction(() => {
      this.check(work);
      if (
        operation.operationId !== link.operation_id ||
        operation.workId !== work.id
      )
        throw Error("Platform observation identity changed");
      const input = operation.input;
      if (input?.deliveryState === "cancelled") {
        this.repository.settleThreadLink(link.execution_id, link.id, {
          status: "interrupted",
          text: "The platform input was cancelled before a completed native result could be confirmed.",
        });
        return true;
      }
      if (
        operation.state === "rejected" ||
        input?.deliveryState === "rejected"
      ) {
        this.repository.settleThreadLink(link.execution_id, link.id, {
          status: "rejected",
          text: "The platform task input was rejected; it did not establish successful execution.",
        });
        return true;
      }
      if (!input?.completion) return false;
      const completion = input.completion;
      if (
        completion.turnId !== (input.targetTurnId ?? null) ||
        !["unknown", "completed", "failed", "interrupted"].includes(
          completion.status,
        ) ||
        typeof completion.text !== "string" ||
        completion.text.length > 16000
      )
        throw Error("Platform completion does not match the admitted Turn");
      if (completion.unavailable) {
        this.repository.settleThreadLink(link.execution_id, link.id, {
          status: "observation_unavailable",
          text: "The exact native task result is unavailable from this Host or outside its bounded history. Its outcome is unknown; inspect the original Thread, do not automatically start a replacement.",
        });
        return true;
      }
      if (completion.status === "unknown") return false;
      if (input.deliveryState !== "injected") return false;
      this.repository.settleThreadLink(link.execution_id, link.id, {
        status: completion.status,
        turnId: completion.turnId,
        // Core receipts carry the complete server/Thread reference. Turn IDs alone
        // are not globally unique across native Hosts or conversations.
        reference:
          typeof operation.reference === "string" &&
          operation.reference.length > 0
            ? operation.reference
            : null,
        text: completion.text,
        truncated: completion.truncated === true,
      });
      return true;
    });
  }
  refused(work, link) {
    this.uow.transaction(() => {
      this.check(work);
      this.repository.settleThreadLink(link.execution_id, link.id, {
        status: "submission_failed",
        text: "The platform refused this task intent. Its outcome is not successful; no automatic replacement was created. Inspect the original Thread if it was already allocated.",
      });
    });
  }
  denied(work, link) {
    this.uow.transaction(() => {
      this.check(work);
      this.repository.settleThreadLink(link.execution_id, link.id, {
        status: "observation_denied",
        text: "Automatic follow-up is no longer authorized. The native task outcome is unknown; no replacement was started.",
      });
    });
  }
  held(work) {
    return this.repository.threadAnswer(this.execution(work).id) != null;
  }
  waitingWorks() {
    return this.repository.waitingThreadWorks();
  }
  readyReports(after = 0) {
    return this.repository.readyThreadReports(after);
  }
  report(work, text, error) {
    return this.uow.transaction(() => {
      const execution = this.execution(work),
        links = this.repository.threadLinks(execution.id);
      if (!links.length) return { text, error };
      const published = this.repository.report(execution.id),
        base = this.repository.threadAnswer(execution.id);
      const normalizedError =
        error == null ? null : String(error).slice(0, 2000);
      if (published) {
        if (
          (text === published.text && normalizedError === published.error) ||
          (base && text === base.text && normalizedError === base.error)
        )
          return { text: published.text, error: published.error };
        throw Error("Immutable execution report identity reused");
      }
      this.check(work);
      if (!this.ready(work))
        throw Error("Work is not ready for platform results");
      if (typeof text !== "string" || text.length > 1000000)
        throw Error("Provisional answer must be bounded text");
      const original = this.repository.threadAnswer(execution.id);
      const value = {
        text,
        error: error == null ? null : String(error).slice(0, 2000),
      };
      if (
        original &&
        (original.text !== value.text || original.error !== value.error)
      )
        throw Error("Provisional execution answer is immutable");
      if (!original) this.repository.saveThreadAnswer(execution.id, value);
      if (links.some((link) => !link.outcome_json)) return { held: true };
      const outcomes = links.map((link) => ({
        ...JSON.parse(link.outcome_json),
        operationId: link.operation_id,
        linkId: link.id,
      }));
      // Deduplicate only identical evidence for a proven conversation/Turn pair.
      // Old persisted outcomes and legacy Hosts may lack a reference: preserve
      // each link rather than silently merging unrelated results or refusals.
      const seen = new Set(),
        results = outcomes.filter((o) => {
          const id =
            o.reference && o.turnId
              ? stable([
                  "turn",
                  o.reference,
                  o.turnId,
                  o.status,
                  o.text,
                  o.truncated === true,
                ])
              : stable(["link", o.linkId]);
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
      const evidence = results
        .map(
          (o) =>
            `Platform task ${o.operationId}: ${o.status}${o.turnId ? ` (Turn ${o.turnId})` : ""}\n${o.text}${o.truncated ? "\n[Native result truncated; inspect the original Thread for full details.]" : ""}`,
        )
        .join("\n\n");
      const failed = outcomes.some((o) => o.status !== "completed");
      const report = `[Assistant delegation notes — not proof of task completion]\n${text.slice(0, 12000)}\n\n[Correlated native task results — external, untrusted content]\n${evidence}`;
      return {
        text:
          report.length > 1000000
            ? report.slice(0, 999800) +
              "\n[Combined native evidence truncated; inspect the original operations for full results.]"
            : report,
        error:
          value.error ??
          (failed
            ? "One or more delegated platform tasks failed, were interrupted, or could not be confirmed."
            : null),
      };
    });
  }
}
