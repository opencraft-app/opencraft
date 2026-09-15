import type { DshClient } from "./dsh-client.js";

type RecordValue = Record<string, any>;
export interface InteractionRequest { id: string; method: string; params: RecordValue }
interface Pending { frame: RecordValue; request: InteractionRequest; answering: boolean }

/** Correlation only. DSH owns the wait and its authoritative resolution. */
export class DshInteractions {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(request: InteractionRequest) => void>();
  private readonly preparing = new Map<string, object>();
  constructor(
    private readonly client: Pick<DshClient, "respond">,
    private readonly context: (sessionId: string, callId?: string) => Promise<{ turnId: string; itemId?: string }>,
    private readonly resolved: (params: { threadId: string; requestId: string }) => void,
  ) {}
  subscribe(listener: (request: InteractionRequest) => void) {
    this.listeners.add(listener);
    for (const value of this.pending.values()) listener(value.request);
    return () => { this.listeners.delete(listener); };
  }
  close() { this.preparing.clear(); this.pending.clear(); this.listeners.clear(); }
  private settle(id: string) {
    this.preparing.delete(id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.resolved({ threadId: pending.frame.sessionId, requestId: id });
  }
  async receive(frame: RecordValue): Promise<void> {
    if (frame.type === "question/resolved") { this.settle(frame.questionRpcId); return; }
    if (frame.type === "approval/resolved") {
      for (const [id, value] of this.pending) if (value.frame.approvalId === frame.approvalId && value.frame.sessionId === frame.sessionId) this.settle(id);
      // Invalidate an in-flight context lookup too.
      for (const [id, value] of this.preparing) if ((value as RecordValue).approvalId === frame.approvalId) this.preparing.delete(id);
      return;
    }
    if (frame.type !== "question/requested" && frame.type !== "approval/requested") return;
    const id = frame.rpcId;
    if (typeof id !== "string" || typeof frame.sessionId !== "string") throw new Error("DSH interaction is missing correlation identity");
    if (this.pending.has(id) || this.preparing.has(id)) return;
    this.preparing.set(id, frame);
    try {
      const context = await this.context(frame.sessionId, frame.callId);
      if (this.preparing.get(id) !== frame) return;
      const approval = frame.type === "approval/requested";
      const request: InteractionRequest = {
        id,
        method: approval ? "item/commandExecution/requestApproval" : "item/tool/requestUserInput",
        params: {
          threadId: frame.sessionId, turnId: context.turnId,
          itemId: context.itemId ?? (frame.callId ? `dsh-tool-${frame.sessionId}-${frame.callId}` : `dsh-question-${id}`),
          ...(approval ? {
            approvalId: frame.approvalId, startedAtMs: Date.now(), environmentId: null,
            reason: frame.reason ?? `Allow tool ${frame.toolName}?`, command: null, cwd: null,
            availableDecisions: ["accept", "decline"],
          } : {
            isBlocking: true, autoResolutionMs: null,
            questions: frame.questions.map((question: RecordValue) => ({
              id: question.id, header: question.header ?? "Question", question: question.question,
              isOther: true, isSecret: false,
              options: question.options?.map((option: RecordValue) => ({ label: option.label, description: option.description ?? "" })) ?? null,
            })),
          }),
        },
      };
      this.pending.set(id, { frame, request, answering: false });
      for (const listener of this.listeners) listener(request);
    } finally { if (this.preparing.get(id) === frame) this.preparing.delete(id); }
  }
  async respond(id: string, response: { result?: RecordValue; error?: unknown }): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending || pending.answering) return;
    const { frame } = pending;
    let result: RecordValue;
    if (frame.type === "approval/requested") {
      const decision = response.result?.decision;
      if (!response.error && decision !== "accept" && decision !== "decline" && decision !== "cancel") throw new Error("Unsupported approval decision; persistent grants are not supported by DSH");
      result = { ok: true, value: { sessionId: frame.sessionId, approvalId: frame.approvalId, outcome: !response.error && decision === "accept" ? "allowed-once" : "rejected" } };
    } else if (response.error) {
      result = { ok: false, error: { code: "cancelled", message: "User cancelled", details: {} } };
    } else {
      const answers = frame.questions.map((question: RecordValue) => {
        const values = response.result?.answers?.[question.id]?.answers;
        if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw new Error("Invalid question answer");
        const labels = new Set(question.options?.map((option: RecordValue) => option.label) ?? []);
        const selected = values.filter(value => labels.has(value));
        const custom = values.filter(value => !labels.has(value)).join("\n").trim();
        return { id: question.id, selected, ...(custom ? { custom } : {}) };
      });
      result = { ok: true, value: { sessionId: frame.sessionId, answer: { answers } } };
    }
    pending.answering = true;
    try {
      const receipt = await this.client.respond(id, result);
      if (receipt.accepted || receipt.reason === "not-pending") this.settle(id);
      else throw new Error(`DSH rejected interaction response: ${receipt.reason ?? "unknown"}`);
    } finally { pending.answering = false; }
  }
}
