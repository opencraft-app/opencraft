import type { InteractionSourceRequest, SharedInteraction, SharedInteractionSnapshot } from "@opencraft/appserver-protocol";

interface Entry {
  source: InteractionSourceRequest;
  value: SharedInteraction;
  readonly offered: Set<string>;
  readonly legacyId?: string;
  answer?: { submissionId: string; fingerprint: string };
}
export type InteractionWriter = (
  source: InteractionSourceRequest,
  result: Record<string, unknown>,
  assertCurrent: () => void,
) => Promise<void | "resolved">;
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
export class InteractionFault extends Error {
  readonly rpcCode = -32083;
  constructor(readonly domainData: { code: string; submissionOutcome?: "rejected" }, message: string) { super(message); }
}

/** The producer explicitly refused the answer without consuming the wait. */
export class InteractionResponseRejected extends InteractionFault {
  constructor(data: { code: string }, message: string) {
    super({ ...data, submissionOutcome: "rejected" }, message);
  }
}

/** The caller can prove that its writer was stopped before sending the response. */
export class InteractionResponseNotDispatched extends InteractionResponseRejected {
  constructor(cause: unknown) {
    const fault = cause instanceof InteractionFault ? cause : undefined;
    super(fault?.domainData ?? { code: "SOURCE_UNAVAILABLE" }, fault?.message ?? "Interaction response subscription expired");
    this.cause = cause;
  }
}

/** Producer-scoped human wait projection. Native execution owns actual resolution.
 * A response admission is synchronous; delivery never removes a pending source. */
export class HostInteractions {
  private readonly epoch = crypto.randomUUID();
  private readonly entries = new Map<string, Entry>();
  private readonly nativeIds = new Map<string, string>();
  private readonly legacyIds = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  private readonly resolved = new Map<string, string>();
  private readonly listeners = new Set<(threadId: string) => void>();
  constructor(private readonly options: { isolateLegacyIds?: boolean } = {}) {}
  get size(): number { return this.entries.size; }
  subscribe(listener: (threadId: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  hasThread(threadId: string): boolean { return [...this.entries.values()].some(e => e.value.params.threadId === threadId); }
  threadForNative(id: string | number): string | null {
    const e = this.entries.get(this.nativeIds.get(JSON.stringify(id)) ?? "");
    return typeof e?.value.params.threadId === "string" ? e.value.params.threadId : null;
  }
  private legacyKey(id: string | number): string | undefined {
    if (!this.options.isolateLegacyIds) return this.nativeIds.get(JSON.stringify(id));
    return typeof id === "string" ? this.legacyIds.get(id) : undefined;
  }
  threadForLegacy(id: string | number): string | null {
    const e = this.entries.get(this.legacyKey(id) ?? "");
    return typeof e?.value.params.threadId === "string" ? e.value.params.threadId : null;
  }
  capture(source: InteractionSourceRequest): string {
    const key = JSON.stringify(source.id), stable = source.__opencraftInteractionKey;
    const id = stable ?? this.nativeIds.get(key) ?? `interaction:${this.epoch}:${crypto.randomUUID()}`;
    const currentNative = this.nativeIds.get(key);
    if (currentNative && currentNative !== id) {
      const previousRoute = this.entries.get(currentNative);
      // A new stable producer identity may replace a suspended route, never a live one.
      // Keep the old interaction unavailable; transport ID reuse does not resolve it.
      if (!stable || !previousRoute?.source.__opencraftInteractionKey || previousRoute.value.canRespond !== false)
        throw new InteractionFault({ code: "SOURCE_CONFLICT" }, "Native request identity is still in use");
    }
    if (this.resolved.has(id)) throw new InteractionFault({ code: "SOURCE_RETIRED" }, "Interaction source has already retired");
    const previous = this.entries.get(id);
    if (previous) {
      if (canonical(previous.source.params) !== canonical(source.params) || previous.source.method !== source.method)
        throw new InteractionFault({ code: "SOURCE_CONFLICT" }, "Interaction source identity was reused");
      if (this.nativeIds.get(JSON.stringify(previous.source.id)) === id) this.nativeIds.delete(JSON.stringify(previous.source.id));
      previous.source = source;
      previous.value = { ...previous.value, canRespond: true };
      // A producer replay, rather than a UI retry, establishes current state.
      if (source.__opencraftInteractionState) {
        previous.value = { ...previous.value, state: source.__opencraftInteractionState };
        if (source.__opencraftInteractionState === "pending") previous.answer = undefined;
      }
    } else {
      if (this.entries.size >= 256) throw new InteractionFault({ code: "LIMIT" }, "Too many pending interactions");
      // A renderer must never answer a different wait by echoing a reused
      // native correlation. Private native IDs stay on the provider lane.
      const legacyId = this.options.isolateLegacyIds ? `opencraft:interaction:${crypto.randomUUID()}` : undefined;
      if (legacyId) this.legacyIds.set(legacyId, id);
      this.entries.set(id, { source, legacyId, offered: new Set(), value: { id, method: source.method, params: source.params,
        state: source.__opencraftInteractionState ?? "pending", canRespond: true, receivedAtMs: Date.now() } });
    }
    this.nativeIds.set(key, id); this.publish(String(source.params.threadId)); return id;
  }
  markSourceUnavailable(threadId?: string): void {
    const changed = new Set<string>();
    for (const entry of this.entries.values()) {
      const id = String(entry.value.params.threadId);
      if ((threadId !== undefined && threadId !== id) || entry.value.canRespond === false) continue;
      entry.value = { ...entry.value, canRespond: false }; entry.offered.clear(); changed.add(id);
    }
    for (const id of changed) this.publish(id);
  }
  snapshot(threadId: string, canRespond: boolean): SharedInteractionSnapshot {
    return { threadId, epoch: this.epoch, revision: this.revisions.get(threadId) ?? 0, canRespond,
      requests: [...this.entries.values()].filter(e => e.value.params.threadId === threadId).map(e => e.value) };
  }
  offerLegacy(threadId: string, clientId: string, send: (source: InteractionSourceRequest) => void): void {
    for (const [id, e] of [...this.entries]) {
      if (this.entries.get(id) !== e || e.value.params.threadId !== threadId || e.value.canRespond === false ||
          e.value.state !== "pending" || e.offered.has(clientId)) continue;
      e.offered.add(clientId);
      send(e.legacyId ? { id: e.legacyId, method: e.source.method, params: e.source.params } : e.source);
    }
  }
  wasOffered(id: string | number, clientId: string): boolean {
    return this.entries.get(this.legacyKey(id) ?? "")?.offered.has(clientId) === true;
  }
  forgetClient(clientId: string, threadId?: string): void {
    for (const e of this.entries.values()) if (threadId === undefined || e.value.params.threadId === threadId) e.offered.delete(clientId);
  }
  async respondLegacy(id: string | number, clientId: string, submissionId: string, result: Record<string, unknown>,
    write: InteractionWriter): Promise<void> {
    const key = this.legacyKey(id);
    const e = key === undefined ? undefined : this.entries.get(key);
    if (!e?.offered.has(clientId) || key === undefined) return;
    await this.respond(String(e.value.params.threadId), key, submissionId, result, write);
  }
  async respondNative(id: string | number, submissionId: string, result: Record<string, unknown>,
    write: InteractionWriter,
    validate?: (source: InteractionSourceRequest, result: Record<string, unknown>) => void): Promise<void> {
    const key = this.nativeIds.get(JSON.stringify(id));
    if (!key) return;
    await this.respond(String(this.entries.get(key)!.value.params.threadId), key, submissionId, result, write, validate);
  }
  async respond(threadId: string, id: string, submissionId: string, result: Record<string, unknown>,
    write: InteractionWriter,
    validate?: (source: InteractionSourceRequest, result: Record<string, unknown>) => void): Promise<"submitted" | "already-submitted" | "resolved"> {
    const e = this.entries.get(id);
    if (!e) {
      if (this.resolved.get(id) === threadId) return "resolved";
      throw new InteractionFault({ code: "NOT_FOUND" }, "Interaction is no longer available");
    }
    if (e.value.params.threadId !== threadId) throw new InteractionFault({ code: "SCOPE" }, "Interaction belongs to another conversation");
    if (e.value.canRespond === false) throw new InteractionFault({ code: "SOURCE_UNAVAILABLE" }, "Interaction source is unavailable");
    const fingerprint = canonical(result);
    const admission = (): "already-submitted" | "resolved" | undefined => {
      if (this.entries.get(id) !== e) return "resolved";
      if (e.value.canRespond === false) throw new InteractionFault({ code: "SOURCE_UNAVAILABLE" }, "Interaction source is unavailable");
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
    const source = e.source;
    const assertCurrent = () => {
      if (this.entries.get(id) !== e || e.answer !== answer || e.value.state !== "responding" ||
          e.value.canRespond === false || e.source.id !== source.id)
        throw new InteractionFault({ code: "SOURCE_CHANGED" }, "Interaction source changed during admission");
    };
    e.answer = answer;
    e.value = { ...e.value, state: "responding" };
    // Claim before publishing: synchronous observers cannot admit another answer.
    this.publish(threadId);
    if (this.entries.get(id) !== e) return "resolved";
    let writerInvoked = false;
    try {
      assertCurrent();
      writerInvoked = true;
      return (await write(source, result, assertCurrent)) ?? "submitted";
    } catch (cause) {
      const refused = !writerInvoked || cause instanceof InteractionResponseRejected;
      // A producer replay can retire this attempt or supply newer response state.
      if (this.entries.get(id) === e && e.answer === answer && (!refused || e.value.state === "responding")) {
        if (refused) e.answer = undefined;
        e.value = { ...e.value, state: refused ? "pending" : "unconfirmed" };
        this.publish(threadId);
      }
      throw cause;
    }
  }
  resolveNative(id: string | number, threadId: string): string | undefined {
    const key = this.nativeIds.get(JSON.stringify(id)), e = key ? this.entries.get(key) : undefined;
    if (!key || !e || e.value.params.threadId !== threadId) return;
    this.retire(key, e);
    this.publish(threadId);
    return e.legacyId;
  }
  private retire(key: string, e: Entry): void {
    const threadId = String(e.value.params.threadId);
    this.entries.delete(key);
    if (e.legacyId) this.legacyIds.delete(e.legacyId);
    if (this.nativeIds.get(JSON.stringify(e.source.id)) === key) this.nativeIds.delete(JSON.stringify(e.source.id));
    this.resolved.set(key, threadId);
    while (this.resolved.size > 256) this.resolved.delete(this.resolved.keys().next().value!);
  }
  resolveTurn(threadId: string, turnId: string): string[] {
    const legacyIds: string[] = [];
    const before = this.entries.size;
    for (const [key, e] of this.entries) {
      if (e.source.params.threadId !== threadId || e.source.params.turnId !== turnId) continue;
      this.retire(key, e);
      if (e.legacyId) legacyIds.push(e.legacyId);
    }
    // Publishing a partial terminal snapshot would let a listener answer
    // another request belonging to the same terminated Turn.
    if (this.entries.size !== before) this.publish(threadId);
    return legacyIds;
  }
  clear(): void { this.entries.clear(); this.nativeIds.clear(); this.legacyIds.clear(); this.resolved.clear(); this.revisions.clear(); }
  private publish(threadId: string): void {
    this.revisions.set(threadId, (this.revisions.get(threadId) ?? 0) + 1);
    for (const listener of [...this.listeners]) { try { listener(threadId); } catch { /* An observer cannot own native settlement. */ } }
  }
}
