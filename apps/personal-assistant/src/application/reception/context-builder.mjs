import { ReceptionQuery, RECEPTION_LIMITS } from "../../domain/reception-query.mjs";
import { Conversation } from "../../domain/conversation.mjs";
import { ContinuationDecision } from "../../domain/continuation.mjs";

/** Bounded initial view. Canonical history and fresh on-demand queries have separate lifetimes. */
export class ReceptionContextBuilder {
  constructor(reads, queries, workingContext = null) {
    Object.assign(this, { reads, queries, workingContext });
  }
  build(turn) {
    const grant = this.queries.grant(turn);
    if (turn.source_json) return this.reportContext(turn, grant);
    const id = Conversation.messageId(turn.conversation_id, turn.id, "user");
    const history = this.reads.history(turn.conversation_id, id, 20);
    if (!history || history.text !== turn.text)
      throw new Error("Reception input has no matching canonical user message");
    const value = {
      text: turn.text,
      attachments: JSON.parse(turn.query_scope_json ?? "{}").attachments ?? [],
      workingContext: this.workingContext?.view(turn) ?? null,
      messages: history.messages.map((m) => ({
        id: m.id,
        seq: m.seq,
        role: m.role,
        text: m.text.slice(0, 1000),
        truncated: m.text.length > 1000,
      })),
      ...this.queries.seed(grant, { text: turn.text }),
    };
    while (ReceptionQuery.bytes(value) > RECEPTION_LIMITS.contextBytes && value.messages.length > 1)
      value.messages.shift();
    this.boundMemory(value);
    if (ReceptionQuery.bytes(value) > RECEPTION_LIMITS.contextBytes)
      throw new Error("Reception context exceeds its bound");
    return value;
  }
  boundMemory(value) {
    const m = value.memoryContext;
    if (!m) return;
    const arrays = [
      m.recent,
      m.profile,
      m.user?.recent,
      m.user?.profile,
      ...(m.projects?.injected ?? []).flatMap((p) => [p.recent, p.profile]),
      m.agent?.recent,
      m.agent?.profile,
      value.memoryRecall,
    ].filter(Boolean);
    while (ReceptionQuery.bytes(value) > RECEPTION_LIMITS.contextBytes) {
      const target = arrays.find((a) => a.length);
      if (!target) break;
      target.pop();
      m.truncated = true;
    }
  }
  reportContext(turn, grant) {
    const source = JSON.parse(turn.source_json);
    const report = this.reads.report(turn.conversation_id, source.workId);
    if (!report || report.id !== source.reportId) throw new Error("Report is no longer current");
    const history = source.historyAnchor
      ? this.reads.history(turn.conversation_id, source.historyAnchor, 20, false)
      : null;
    const summarizeRequest = (r) =>
      r
        ? {
            ...r,
            text: r.text?.slice(0, 6000),
            truncated: (r.text?.length ?? 0) > 6000,
          }
        : null;
    const value = {
      text: turn.text,
      workingContext: this.workingContext?.view(turn) ?? null,
      source: {
        ...source,
        assessment: undefined,
        request: undefined,
        confirmedInputs: undefined,
        directives: undefined,
      },
      confirmedInputs: source.confirmedInputs ?? { items: [], omitted: true },
      directives: source.directives ?? { items: [], omitted: true },
      goalContext: source.goalId ? this.queries.reportGoal(grant, source) : null,
      request: source.request
        ? {
            original: summarizeRequest(source.request.original),
            latest: summarizeRequest(source.request.latest),
            continuations: source.request.continuations ?? 0,
          }
        : null,
      report: {
        id: report.id,
        platformReadEvidence: source.platformReadEvidence ?? {
          items: [],
          coverage: "not-recorded",
        },
        candidateResultId: `result:${report.execution_id}`, // Not accepted until the host commits deliver.
        workId: report.work_id,
        revision: report.revision,
        status: report.status,
        text: report.text.slice(0, 6000),
        truncated: report.text.length > 6000,
        error: report.error,
        assessment: {
          passed: source.assessment.passed,
          resultPresent: source.assessment.resultPresent,
          semanticReview: source.assessment.semanticReview,
          checks: source.assessment.checks,
          requirements: source.assessment.requirements.slice(0, 4).map((s) => s.slice(0, 120)),
        },
      },
      continuationLimit: ContinuationDecision.maxContinuations,
      messages: (history?.messages ?? []).map((m) => ({
        id: m.id,
        seq: m.seq,
        role: m.role,
        text: m.text.slice(0, 1000),
        truncated: m.text.length > 1000,
      })),
      ...this.queries.seed(grant),
    };
    while (ReceptionQuery.bytes(value) > RECEPTION_LIMITS.contextBytes && value.messages.length > 0)
      value.messages.shift();
    this.boundMemory(value);
    if (ReceptionQuery.bytes(value) > RECEPTION_LIMITS.contextBytes)
      throw new Error("Report context exceeds its bound");
    return value;
  }
}
