import { Interaction } from "../domain/interaction.mjs";
import { requireText } from "../domain/values.mjs";

/** Requests commit before execution suspension; answers commit before scheduling continuation. */
export class InteractionService {
  constructor({
    uow,
    repositories: r,
    inbox,
    works,
    executions,
    executionService,
    ledger,
    history,
    assistant,
    credentials,
    now = Date.now,
  }) {
    Object.assign(this, {
      uow,
      r,
      inbox,
      works,
      executions,
      executionService,
      ledger,
      history,
      assistant,
      credentials,
      now,
    });
  }
  request(work, callId, question, options = {}) {
    return this.uow.transaction(() => {
      this.works.assertCurrent(work);
      const record = Interaction.create(
        work,
        this.executions.get(work).id,
        callId,
        question,
        this.assistant.owner,
        this.now(),
        options,
      );
      const request = this.ledger.open(record);
      if (request.state === "pending") {
        this.works.waitForInput(work);
        this.history.question(request);
      } else if (request.state !== "answered") throw new Error(`Interaction is ${request.state}`);
      return request;
    });
  }
  answer(inputId, params) {
    requireText(params.text, "answer");
    if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 1)
      throw new Error("Interaction revision is required");
    return this.inbox.accept(inputId, "interaction.answer", params, () => {
      const interaction = new Interaction(this.ledger.get(params.interactionId)),
        work = this.works.require(interaction.record.work_id).record;
      this.works.assertCurrent({
        ...work,
        revision: interaction.record.revision,
      });
      const answered = interaction.answer(
        work,
        params.expectedRevision,
        this.assistant.owner,
        params.text,
        inputId,
        this.now(),
      );
      this.ledger.save(answered);
      if (!this.r.interactions.pendingForWork(work.id, work.revision).length) this.works.resumeInput(work);
      this.r.events.append("interaction.answered", work.id, { interactionId: answered.id, inputId }, this.now());
      return {
        interactionId: answered.id,
        workId: work.id,
        revision: work.revision,
        state: "answered",
      };
    });
  }
  resolve(inputId, params) {
    if (
      !params ||
      Object.keys(params).some((key) => !["interactionId", "expectedRevision", "credentialRef", "text"].includes(key))
    )
      throw new Error("Only typed receipt/reference fields are accepted");
    if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 1)
      throw new Error("Interaction revision is required");
    return this.inbox.accept(inputId, "interaction.resolve", params, () => {
      const interaction = new Interaction(this.ledger.get(params.interactionId));
      const i = interaction.record,
        work = this.works.require(i.work_id).record;
      interaction.assertPending(work, params.expectedRevision, this.assistant.owner, this.now());
      let answer;
      if (i.kind === "handoff") {
        if (params.credentialRef !== undefined) throw new Error("Handoff takes an owner report");
        answer = {
          kind: "handoff",
          report: requireText(params.text, "handoff report", 2000),
          verification: "owner-reported",
        };
      } else if (["secret", "authorization"].includes(i.kind)) {
        if (params.text !== undefined)
          throw new Error("Sensitive input must use a credential reference, never chat text");
        if (!this.credentials) throw new Error("Secure credential adapter unavailable");
        const credential = this.credentials.describe(params.credentialRef);
        if (credential.kind !== i.kind || credential.provider !== JSON.parse(i.metadata_json).provider)
          throw new Error("Credential kind/provider does not match this request");
        answer = {
          kind: i.kind,
          credentialRef: credential.reference,
          provider: credential.provider,
          verification: "owner-provided",
        };
      } else throw new Error("Ordinary questions use interaction.answer");
      this.ledger.save({
        ...i,
        state: "answered",
        answer: JSON.stringify(answer),
        answer_input_id: inputId,
        answered_at: this.now(),
      });
      if (!this.r.interactions.pendingForWork(work.id, work.revision).length) this.works.resumeInput(work);
      this.r.events.append("interaction.resolved", work.id, { interactionId: i.id, kind: i.kind }, this.now());
      return {
        interactionId: i.id,
        workId: work.id,
        revision: work.revision,
        state: "answered",
        kind: i.kind,
      };
    });
  }
  expire() {
    for (const request of this.r.interactions.expiring(this.now())) {
      if (request.state !== "pending" || request.expires_at === null || request.expires_at > this.now()) continue;
      this.uow.transaction(() => {
        const work = this.works.require(request.work_id).record;
        if (work.revision !== request.revision || work.status !== "waiting_input") return;
        this.ledger.save({
          ...request,
          state: "expired",
          answered_at: this.now(),
        });
        this.ledger.rejectPending(work.id, work.revision, "deadline", this.now());
        this.executionService.blocked(work, "Intervention deadline expired; revise work to continue");
        this.r.events.append("interaction.expired", work.id, { interactionId: request.id }, this.now());
      });
    }
  }
  reject(inputId, params) {
    if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 1)
      throw new Error("Interaction revision is required");
    return this.inbox.accept(inputId, "interaction.reject", params, () => {
      const interaction = new Interaction(this.ledger.get(params.interactionId)),
        work = this.works.require(interaction.record.work_id).record;
      interaction.assertPending(work, params.expectedRevision, this.assistant.owner, this.now());
      this.ledger.save({
        ...interaction.record,
        state: "rejected",
        answered_at: this.now(),
        answer_input_id: inputId,
      });
      this.ledger.rejectPending(work.id, work.revision, inputId, this.now());
      this.executionService.blocked(work, "User declined the requested information; revise the work to continue");
      this.r.events.append("interaction.rejected", work.id, { interactionId: interaction.record.id }, this.now());
      return {
        interactionId: interaction.record.id,
        workId: work.id,
        state: "rejected",
      };
    });
  }
  list() {
    return this.r.interactions.list();
  }
  confirmedInputs(work) {
    this.works.assertCurrent(work);
    const rows = this.r.interactions.answeredQuestions(work.id, work.revision, this.now(), 33);
    const items = [];
    let bytes = 0,
      omitted = rows.length > 32;
    for (const row of rows.slice(0, 32)) {
      const item = {
        interactionId: row.id,
        sourceExecutionId: row.execution_id,
        revision: row.revision,
        question: row.question,
        answer: row.answer,
        answeredAt: row.answered_at,
        expiresAt: row.expires_at,
      };
      const size = new TextEncoder().encode(JSON.stringify(item)).length;
      // Never present a clipped answer as an authoritative complete fact.
      if (bytes + size > 16000) {
        omitted = true;
        continue;
      }
      items.push(item);
      bytes += size;
    }
    return { items: items.reverse(), omitted };
  }
  pendingForConversation(id) {
    return this.r.interactions.forConversation(id);
  }
  assertInConversation(id, conversationId) {
    const i = this.ledger.get(id);
    if (!i || !this.r.conversations.linked(conversationId, i.work_id))
      throw new Error("Interaction is outside this conversation");
    return i;
  }
}
