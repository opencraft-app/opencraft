import { digest, requireText, requireRevision } from "../domain/values.mjs";
import { WorkItem } from "../domain/work-item.mjs";
import { Routine } from "../domain/routine.mjs";
import { CompletionContract } from "../domain/completion-contract.mjs";

/** WorkItem mutation owner. Other services request lifecycle changes here. */
export class WorkService {
  constructor({
    uow,
    repositories: r,
    inbox,
    scope,
    ledger,
    outcomes,
    interactions,
    assertEditable = () => {},
    now = Date.now,
  }) {
    Object.assign(this, {
      uow,
      r,
      inbox,
      scope,
      ledger,
      outcomes,
      interactions,
      assertEditable,
      now,
    });
  }
  require(id) {
    return new WorkItem(this.r.works.get(id));
  }
  create(
    id,
    message,
    inputId,
    source = "local",
    routine = null,
    completion,
    resources,
    origin = { kind: "direct", notify: "always" },
    request = null,
  ) {
    const at = this.now(),
      w = {
        id,
        text: message,
        revision: 1,
        status: "queued",
        source,
        routine_id: routine?.id ?? null,
        routine_revision: routine?.revision ?? null,
        created_at: at,
        updated_at: at,
        error: null,
        origin_json: JSON.stringify(origin),
        delegation: this.scope.delegate(inputId, resources),
        completion_json: JSON.stringify(
          CompletionContract.create(message, completion),
        ),
      };
    this.r.works.add(w);
    const executionId = this.ledger.create(id, 1, inputId, request);
    this.r.works.activate(id, executionId);
    this.r.events.append("work.accepted", id, { executionId, source }, at);
    return { workId: id, executionId, revision: 1, status: "queued" };
  }
  submit(inputId, params, resources, request = null) {
    requireText(params.text, "text");
    return this.inbox.accept(
      inputId,
      "submit",
      resources === undefined
        ? params
        : { ...params, capturedResources: resources, request },
      () =>
        this.create(
          `w_${digest(inputId).slice(0, 24)}`,
          params.text,
          inputId,
          "local",
          null,
          params.completion,
          resources,
          undefined,
          request,
        ),
    );
  }
  amend(inputId, params, request = null) {
    requireText(params.text, "text");
    return this.inbox.accept(
      inputId,
      "amend",
      request ? { ...params, request } : params,
      () => {
        this.assertEditable(params.workId);
        const current = this.require(params.workId),
          previousRequest = this.ledger.get(current.record)?.request_json,
          w = current.amend(
            params.text,
            params.expectedRevision,
            this.now(),
            params.completion,
          ),
          executionId = `${w.id}:r${w.revision}`;
        this.ledger.retire(w.id, "superseded");
        this.outcomes.withdraw(w.id);
        this.interactions.retire(w.id, "superseded");
        this.r.works.save(w);
        const previous = previousRequest ? JSON.parse(previousRequest) : null;
        const nextRequest = request
          ? {
              ...request,
              ...(previous?.original
                ? {
                    original: previous.original,
                    latest:
                      request.original?.inputId !== previous.original.inputId
                        ? request.original
                        : (request.latest ?? previous.latest),
                  }
                : {}),
            }
          : previous
            ? {
                ...previous,
                continuations: 0,
                latest: { inputId, text: params.text },
              }
            : null;
        this.ledger.create(w.id, w.revision, inputId, nextRequest);
        this.r.works.activate(w.id, executionId);
        this.r.events.append(
          "work.amended",
          w.id,
          { revision: w.revision, inputId },
          this.now(),
        );
        return {
          workId: w.id,
          executionId,
          revision: w.revision,
          status: w.status,
        };
      },
    );
  }
  continue(inputId, params, request = null) {
    requireText(params.text, "continuation text");
    return this.inbox.accept(
      inputId,
      "work.continue",
      { ...params, request },
      () => {
        this.assertEditable(params.workId);
        const w = this.require(params.workId).record;
        if (
          !Number.isSafeInteger(params.expectedRevision) ||
          params.expectedRevision < 1
        )
          throw new Error("Work revision is required");
        requireRevision(params.expectedRevision, w.revision, "work");
        if (
          params.expectedExecutionId &&
          params.expectedExecutionId !== w.active_execution_id
        )
          throw new Error("Execution has changed");
        if (
          ![
            "awaiting_review",
            "blocked",
            "completed",
            "awaiting_delivery",
          ].includes(w.status)
        )
          throw new Error("Work must settle before continuation");
        const old = this.ledger.get(w);
        // A failed process with unresolved host effects cannot be silently adopted.
        if (
          this.r.executions
            .nativeCalls(old.id)
            .some((c) => !c.tool.startsWith("__") && c.state !== "completed")
        )
          throw new Error("Unresolved native effects require reconciliation");
        const previous = old.request_json ? JSON.parse(old.request_json) : {};
        const next = {
          ...previous,
          ...request,
          continuation: { inputId, text: params.text },
          continuations: request?.continuations ?? 0,
        };
        if (next.continuations > 3)
          throw new Error(
            "Automatic continuation limit reached; amend the work explicitly",
          );
        const executionId = this.ledger.continue(w, inputId, next);
        this.r.works.activate(w.id, executionId);
        this.outcomes.withdraw(w.id);
        // Execution ownership changes; same-requirement user answers remain facts.
        this.interactions.retire(w.id, "superseded", { preserveAnswers: true });
        this.r.works.save({
          ...w,
          status: "queued",
          error: null,
          updated_at: this.now(),
        });
        this.r.events.append(
          "work.continued",
          w.id,
          { executionId, predecessorId: old.id, revision: w.revision },
          this.now(),
        );
        return {
          workId: w.id,
          revision: w.revision,
          executionId,
          status: "queued",
        };
      },
    );
  }
  instruct(inputId, params) {
    requireText(params.text, "instruction", 10000);
    return this.inbox.accept(inputId, "work.instruct", params, () => {
      this.assertEditable(params.workId);
      const w = this.require(params.workId).record;
      if (
        !Number.isSafeInteger(params.expectedRevision) ||
        params.expectedRevision < 1
      )
        throw new Error("Work revision is required");
      requireRevision(params.expectedRevision, w.revision, "work");
      if (w.status === "cancelled")
        throw new Error("Cancelled work cannot receive instructions");
      const pending = this.ledger.directives(w.id, "accepted");
      if (
        pending.length >= 32 ||
        pending.reduce((n, d) => n + d.text.length, params.text.length) > 24000
      )
        throw new Error("Pending instruction limit reached");
      const directiveId = `directive:${inputId}`;
      this.ledger.acceptDirective({
        id: directiveId,
        workId: w.id,
        revision: w.revision,
        text: params.text,
        at: this.now(),
      });
      if (
        [
          "awaiting_review",
          "blocked",
          "completed",
          "awaiting_delivery",
        ].includes(w.status)
      )
        this.continue(`instruct:${digest(inputId)}`, {
          workId: w.id,
          expectedRevision: w.revision,
          text: "Process the ordered supplemental instructions without changing the original requirements.",
        });
      return {
        directiveId,
        workId: w.id,
        revision: w.revision,
        state: "accepted",
        delivery: "next-settled-turn-boundary",
      };
    });
  }
  cancelWork(id, expectedRevision) {
    const current = this.require(id);
    requireRevision(expectedRevision, current.record.revision, "work");
    if (current.record.status === "completed")
      return { workId: id, status: "completed", alreadyCompleted: true };
    this.assertEditable(id);
    this.r.works.save(current.cancel(this.now()));
    this.ledger.retire(id, "cancelled");
    this.outcomes.withdraw(id);
    this.interactions.retire(id, "cancelled");
    this.r.events.append("work.cancelled", id, {}, this.now());
    return { workId: id, status: "cancelled" };
  }
  cancel(inputId, params) {
    return this.inbox.accept(inputId, "cancel", params, () =>
      this.cancelWork(params.workId, params.expectedRevision),
    );
  }
  assertCurrent(work) {
    const current = this.require(work.id);
    current.assertCurrent(work);
    if (
      work.active_execution_id &&
      work.active_execution_id !== current.record.active_execution_id
    )
      throw new Error("Execution no longer owns this work");
    if (work.routine_id) {
      const r = this.r.routines.get(work.routine_id);
      if (!r) throw new Error("Routine no longer exists");
      new Routine(r).assertOccurrence(work.routine_revision, this.now());
    }
    return current.record;
  }
  started(work) {
    const current = this.assertCurrent(work);
    this.r.works.save(new WorkItem(current).started(this.now()));
  }
  resultReady(work) {
    const current = this.assertCurrent(work);
    this.r.works.save(new WorkItem(current).resultReady(this.now()));
  }
  awaitingReview(work) {
    this.r.works.save(
      new WorkItem(this.assertCurrent(work)).awaitingReview(this.now()),
    );
  }
  waitForInput(work) {
    const current = this.assertCurrent(work);
    this.r.works.save(new WorkItem(current).waitForInput(this.now()));
  }
  resumeInput(work) {
    const current = this.assertCurrent(work);
    this.r.works.save(new WorkItem(current).resumeInput(this.now()));
  }
  delivered(workId, revision) {
    const current = this.require(workId);
    this.r.works.save(current.delivered(revision, this.now()));
  }
  blocked(work, error) {
    const current = this.r.works.get(work.id);
    if (
      !current ||
      current.revision !== work.revision ||
      (work.active_execution_id &&
        work.active_execution_id !== current.active_execution_id) ||
      ![
        "queued",
        "running",
        "blocked",
        "waiting_input",
        "awaiting_review",
      ].includes(current.status)
    )
      return false;
    this.r.works.save({
      ...current,
      status: "blocked",
      error: String(error).slice(0, 2000),
      updated_at: this.now(),
    });
    return true;
  }
}
