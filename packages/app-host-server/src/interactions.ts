import { randomUUID } from "node:crypto";
import type { InteractionSourceRequest, SharedInteraction, SharedInteractionSnapshot } from "@opencraft/appserver-protocol";

interface Entry {
  source: InteractionSourceRequest;
  value: SharedInteraction;
  readonly offered: Set<string>;
  answer?: { submissionId: string; fingerprint: string };
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
export class InteractionFault extends Error {
  readonly rpcCode = -32083;
  constructor(readonly domainData: { code: string }, message: string) { super(message); }
}

/** Producer-scoped human wait projection. Native execution owns actual resolution.
 * A response admission is synchronous; delivery never removes a pending source. */
export class HostInteractions {
  private readonly epoch = randomUUID();
  private readonly entries = new Map<string, Entry>();
  private readonly nativeIds = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  private readonly resolved = new Map<string, string>();
  private readonly listeners = new Set<(threadId: string) => void>();
  get size(): number { return this.entries.size; }
  subscribe(listener: (threadId: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  hasThread(threadId: string): boolean { return [...this.entries.values()].some(e => e.value.params.threadId === threadId); }
  threadForNative(id: string | number): string | null {
    const e = this.entries.get(this.nativeIds.get(JSON.stringify(id)) ?? "");
    return typeof e?.value.params.threadId === "string" ? e.value.params.threadId : null;
  }
  capture(source: InteractionSourceRequest): string {
    const key = JSON.stringify(source.id), stable = source.__opencraftInteractionKey;
    const id = stable ?? this.nativeIds.get(key) ?? `interaction:${this.epoch}:${randomUUID()}`;
    const currentNative = this.nativeIds.get(key);
    if (currentNative && currentNative !== id) throw new InteractionFault({ code: "SOURCE_CONFLICT" }, "Native request identity is still in use");
    if (this.resolved.has(id)) throw new InteractionFault({ code: "SOURCE_RETIRED" }, "Interaction source has already retired");
    const previous = this.entries.get(id);
    if (previous) {
      if (canonical(previous.source.params) !== canonical(source.params) || previous.source.method !== source.method)
        throw new InteractionFault({ code: "SOURCE_CONFLICT" }, "Interaction source identity was reused");
      this.nativeIds.delete(JSON.stringify(previous.source.id));
      previous.source = source;
      // A producer replay, rather than a UI retry, establishes current state.
      if (source.__opencraftInteractionState) {
        previous.value = { ...previous.value, state: source.__opencraftInteractionState };
        if (source.__opencraftInteractionState === "pending") previous.answer = undefined;
      }
    } else {
      if (this.entries.size >= 256) throw new InteractionFault({ code: "LIMIT" }, "Too many pending interactions");
      this.entries.set(id, { source, offered: new Set(), value: { id, method: source.method, params: source.params,
        state: source.__opencraftInteractionState ?? "pending", receivedAtMs: Date.now() } });
    }
    this.nativeIds.set(key, id); this.publish(String(source.params.threadId)); return id;
  }
  snapshot(threadId: string, canRespond: boolean): SharedInteractionSnapshot {
    return { threadId, epoch: this.epoch, revision: this.revisions.get(threadId) ?? 0, canRespond,
      requests: [...this.entries.values()].filter(e => e.value.params.threadId === threadId).map(e => e.value) };
  }
  offerLegacy(threadId: string, clientId: string, send: (source: InteractionSourceRequest) => void): void {
    for (const e of [...this.entries.values()]) {
      if (e.value.params.threadId !== threadId || e.value.state !== "pending" || e.offered.has(clientId)) continue;
      e.offered.add(clientId); send(e.source);
    }
  }
  wasOffered(id: string | number, clientId: string): boolean {
    return this.entries.get(this.nativeIds.get(JSON.stringify(id)) ?? "")?.offered.has(clientId) === true;
  }
  forgetClient(clientId: string, threadId?: string): void {
    for (const e of this.entries.values()) if (threadId === undefined || e.value.params.threadId === threadId) e.offered.delete(clientId);
  }
  async respondNative(id: string | number, submissionId: string, result: Record<string, unknown>,
    write: (source: InteractionSourceRequest, result: Record<string, unknown>) => Promise<void>,
    validate?: (source: InteractionSourceRequest, result: Record<string, unknown>) => void): Promise<void> {
    const key = this.nativeIds.get(JSON.stringify(id));
    if (!key) return;
    await this.respond(String(this.entries.get(key)!.value.params.threadId), key, submissionId, result, write, validate);
  }
  async respond(threadId: string, id: string, submissionId: string, result: Record<string, unknown>,
    write: (source: InteractionSourceRequest, result: Record<string, unknown>) => Promise<void>,
    validate?: (source: InteractionSourceRequest, result: Record<string, unknown>) => void): Promise<"submitted" | "already-submitted" | "resolved"> {
    const e = this.entries.get(id);
    if (!e) {
      if (this.resolved.get(id) === threadId) return "resolved";
      throw new InteractionFault({ code: "NOT_FOUND" }, "Interaction is no longer available");
    }
    if (e.value.params.threadId !== threadId) throw new InteractionFault({ code: "SCOPE" }, "Interaction belongs to another conversation");
    const fingerprint = canonical(result);
    const admission = (): "already-submitted" | "resolved" | undefined => {
      if (this.entries.get(id) !== e) return "resolved";
      if (e.value.state === "pending") return;
      if (e.answer?.submissionId === submissionId && e.answer.fingerprint !== fingerprint)
        throw new InteractionFault({ code: "RESPONSE_CONFLICT" }, "Submission identity was reused with another response");
      return "already-submitted";
    };
    const beforeValidation = admission();
    if (beforeValidation) return beforeValidation;
    validate?.(e.source, result);
    // Validation is external code: it may retire the entry or admit a peer.
    const afterValidation = admission();
    if (afterValidation) return afterValidation;
    const answer = { submissionId, fingerprint };
    e.answer = answer;
    e.value = { ...e.value, state: "responding" };
    // Claim before publishing: synchronous observers cannot admit another answer.
    this.publish(threadId);
    if (this.entries.get(id) !== e) return "resolved";
    if (e.answer !== answer || e.value.state !== "responding")
      throw new InteractionFault({ code: "SOURCE_CHANGED" }, "Interaction source changed during admission");
    try { await write(e.source, result); }
    catch (cause) {
      // A producer pending replay can reuse Entry while revoking this answer.
      if (this.entries.get(id) === e && e.answer === answer) { e.value = { ...e.value, state: "unconfirmed" }; this.publish(threadId); }
      throw cause;
    }
    return "submitted";
  }
  resolveNative(id: string | number, threadId: string): void {
    const key = this.nativeIds.get(JSON.stringify(id)), e = key ? this.entries.get(key) : undefined;
    if (!key || !e || e.value.params.threadId !== threadId) return;
    this.entries.delete(key); this.nativeIds.delete(JSON.stringify(id));
    this.resolved.set(key, threadId);
    while (this.resolved.size > 256) this.resolved.delete(this.resolved.keys().next().value!);
    this.publish(threadId);
  }
  resolveTurn(threadId: string, turnId: string): void {
    for (const e of [...this.entries.values()]) if (e.source.params.threadId === threadId && e.source.params.turnId === turnId) this.resolveNative(e.source.id, threadId);
  }
  clear(): void { this.entries.clear(); this.nativeIds.clear(); this.resolved.clear(); this.revisions.clear(); }
  private publish(threadId: string): void {
    this.revisions.set(threadId, (this.revisions.get(threadId) ?? 0) + 1);
    for (const listener of [...this.listeners]) { try { listener(threadId); } catch { /* An observer cannot own native settlement. */ } }
  }
}
