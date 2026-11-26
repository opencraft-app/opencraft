import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { HostInteractions, InteractionResponseNotDispatched, InteractionResponseRejected, type InteractionWriter } from "@opencraft/app-host-server/interactions";
import { nodeObserver } from "@opencraft/observability-contract/node";
import type { DshClient } from "./dsh-client.js";

type RecordValue = Record<string, any>;
export interface InteractionRequest { id: string; method: string; params: RecordValue }
interface Pending {
  frame: RecordValue;
  request: InteractionRequest;
  available: boolean;
  answering: boolean;
}

function rememberRecent(entries: Set<string>, key: string): void {
  entries.add(key);
  if (entries.size > 256) entries.delete(entries.values().next().value!);
}

function sameNativeSession(left: RecordValue, right: RecordValue): boolean {
  return left.sessionId === right.sessionId &&
    (left.nativeSessionId ?? left.sessionId) === (right.nativeSessionId ?? right.sessionId);
}

/** Correlation only. DSH owns the wait and its authoritative resolution. */
export class DshInteractions {
  readonly shared = new HostInteractions();
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<string, (request: InteractionRequest) => void>();
  private readonly preparing = new Map<string, RecordValue>();
  private readonly retiredRequests = new Set<string>();
  private readonly terminalTurns = new Set<string>();
  constructor(
    private readonly client: Pick<DshClient, "respond">,
    private readonly context: (sessionId: string, callId?: string) => Promise<{ turnId: string; itemId?: string }>,
    private readonly resolved: (params: { threadId: string; requestId: string }) => void,
  ) {
    this.shared.subscribe(threadId => {
      for (const [clientId, listener] of [...this.listeners]) this.offerLegacy(threadId, clientId, listener);
    });
  }
  private offerLegacy(threadId: string, clientId: string, listener: (request: InteractionRequest) => void): void {
    this.shared.offerLegacy(threadId, clientId, source => {
      if (typeof source.id === "string") listener({ id: source.id, method: source.method, params: source.params });
    });
  }
  subscribe(listener: (request: InteractionRequest) => void) {
    const clientId = randomUUID();
    this.listeners.set(clientId, listener);
    const threads = new Set([...this.pending.values()].map(value => String(value.frame.sessionId)));
    for (const threadId of threads) this.offerLegacy(threadId, clientId, listener);
    return () => { this.listeners.delete(clientId); this.shared.forgetClient(clientId); };
  }
  markSourceUnavailable(): void {
    this.preparing.clear();
    for (const pending of this.pending.values()) pending.available = false;
    this.shared.markSourceUnavailable();
  }
  close() {
    this.shared.clear();
    this.preparing.clear();
    this.pending.clear();
    this.retiredRequests.clear();
    this.terminalTurns.clear();
    this.listeners.clear();
  }
  resolveTurn(threadId: string, turnId: string): void {
    rememberRecent(this.terminalTurns, JSON.stringify([threadId, turnId]));
    for (const [id, pending] of this.pending) {
      if (pending.frame.sessionId === threadId && pending.request.params.turnId === turnId) this.settle(id);
    }
  }
  private settle(id: string) {
    this.preparing.delete(id);
    rememberRecent(this.retiredRequests, id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.shared.resolveNative(id, pending.frame.sessionId);
    this.resolved({ threadId: pending.frame.sessionId, requestId: id });
  }
  async receive(frame: RecordValue): Promise<void> {
    if (frame.type === "question/resolved") {
      const id = frame.questionRpcId;
      const request = this.pending.get(id)?.frame ?? this.preparing.get(id);
      if (request?.type === "question/requested" && sameNativeSession(request, frame)) this.settle(id);
      return;
    }
    if (frame.type === "approval/resolved") {
      const matches = (request: RecordValue) => request.type === "approval/requested" &&
        request.approvalId === frame.approvalId && sameNativeSession(request, frame);
      for (const [id, value] of this.pending) if (matches(value.frame)) this.settle(id);
      for (const [id, value] of this.preparing) if (matches(value)) this.settle(id);
      return;
    }
    if (frame.type !== "question/requested" && frame.type !== "approval/requested") return;
    const id = frame.rpcId;
    if (typeof id !== "string" || typeof frame.sessionId !== "string") throw new Error("DSH interaction is missing correlation identity");
    if (this.retiredRequests.has(id) || this.preparing.has(id)) return;
    const previous = this.pending.get(id);
    if (previous) {
      if (!previous.available) {
        if (!isDeepStrictEqual(previous.frame, frame)) throw new Error("DSH interaction source changed during replay");
        previous.available = true;
        // Reuse the original Thread, Turn and public wait identity. DSH replays
        // the request body without certifying a previous HTTP answer's outcome.
        this.shared.capture(previous.request);
      }
      return;
    }
    this.preparing.set(id, frame);
    try {
      const context = await this.context(frame.sessionId, frame.callId);
      if (this.preparing.get(id) !== frame) return;
      if (this.terminalTurns.has(JSON.stringify([frame.sessionId, context.turnId]))) {
        rememberRecent(this.retiredRequests, id);
        return;
      }
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
              ...(typeof question.multiSelect === "boolean" ? { multiSelect: question.multiSelect } : {}),
              ...(typeof question.detail === "string" ? { detail: question.detail } : {}),
              ...(question.intent ? { intent: question.intent } : {}),
              id: question.id, header: question.header ?? "Question", question: question.question,
              isOther: true, isSecret: false,
              options: question.options?.map((option: RecordValue) => ({ label: option.label, description: option.description ?? "" })) ?? null,
            })),
          }),
        },
      };
      nodeObserver('dsh').execution('dsh',request.method,request.params);
      this.pending.set(id, { frame, request, available: true, answering: false });
      try { this.shared.capture(request); }
      catch (error) { this.pending.delete(id); throw error; }
    } finally { if (this.preparing.get(id) === frame) this.preparing.delete(id); }
  }
  async respond(id: string, response: { result?: RecordValue; error?: unknown }, assertSubscriber?: () => void): Promise<void> {
    if (response.error) return; // A missing client handler cannot cancel another client's human wait.
    await this.shared.respondNative(id, `legacy:${randomUUID()}`, response.result ?? {},
      this.writer(assertSubscriber), this.validateResponse);
  }
  async respondShared(threadId: string, id: string, submissionId: string, result: RecordValue, assertSubscriber?: () => void) {
    return this.shared.respond(threadId, id, submissionId, result, this.writer(assertSubscriber), this.validateResponse);
  }
  private readonly validateResponse = (source: Parameters<InteractionWriter>[0], result: RecordValue): void => {
    const pending = this.pending.get(String(source.id));
    if (pending) this.responseResult(pending.frame, { result });
  };
  private writer(assertSubscriber?: () => void): InteractionWriter {
    return async (source, result, assertCurrent) => {
      const id = String(source.id);
      const pending = this.pending.get(id);
      try {
        if (!pending || pending.answering || this.terminalTurns.has(JSON.stringify([source.params.threadId, source.params.turnId])))
          throw new Error("DSH interaction no longer owns the reply");
        assertSubscriber?.();
        assertCurrent();
      } catch (cause) {
        throw new InteractionResponseNotDispatched(cause);
      }
      const frame = pending.frame;
      const response = this.responseResult(frame, { result });
      pending.answering = true;
      try {
        const receipt = await this.client.respond(id, response, {
          logicalSessionId: frame.sessionId, nativeSessionId: frame.nativeSessionId ?? frame.sessionId,
        });
        if (!receipt.accepted && receipt.reason === "bad-response")
          throw new InteractionResponseRejected({ code: "INVALID_RESPONSE" }, "DSH refused the interaction response");
        if (this.pending.get(id) === pending) this.settle(id);
        if (!receipt.accepted) return "resolved";
      } finally { pending.answering = false; }
    };
  }
  private responseResult(frame: RecordValue, response: { result?: RecordValue; error?: unknown }): RecordValue {
    const sessionId = frame.nativeSessionId ?? frame.sessionId;
    let result: RecordValue;
    if (frame.type === "approval/requested") {
      const decision = response.result?.decision;
      if (!response.error && decision !== "accept" && decision !== "decline" && decision !== "cancel") throw new Error("Unsupported approval decision; persistent grants are not supported by DSH");
      result = { ok: true, value: { sessionId, approvalId: frame.approvalId, outcome: !response.error && decision === "accept" ? "allowed-once" : "rejected" } };
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
      result = { ok: true, value: { sessionId, answer: { answers } } };
    }
    return result;
  }
}
