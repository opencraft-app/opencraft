import { DshClientError, type DshEvent, type DshStreamEnvelope } from "./dsh-client.js";
export interface DshSessionGeneration {
  logicalId: string; nativeId: string; generation: number;
  seedThroughSeq: number; seedThroughTurn: number; previousLastSeq: number; previousLastTurn: number;
}

/** Deterministic domain rejection: no unknown storage effect and no new route. */
export class DshRoutingRejection extends Error {
  constructor(readonly code: "INVALID_ROUTE" | "INCOMPLETE_EVIDENCE" | "AUTHORITY_CHANGED", message: string) {
    super(message); this.name = "DshRoutingRejection";
  }
}

export interface DshPendingGeneration {
  logicalId: string; nativeId: string;
  intent: { expectedNativeId: string; generation: number; previousLastSeq: number; previousLastTurn: number } | null;
}
export interface DshRoutingSnapshot {
  generations: DshSessionGeneration[];
  pending: DshPendingGeneration[];
}
/** A committed projection only. All coordinates and stream translation have one
 * implementation, shared by the Worker owner and the network-thread reader. */
export class DshRoutingProjection {
  private routes = new Map<string, DshSessionGeneration[]>();
  private natives = new Map<string, DshSessionGeneration>();
  private staged = new Map<string, DshPendingGeneration>();
  protected assertReadable(): void {}
  protected replaceSnapshot(snapshot: DshRoutingSnapshot): void {
    const routes = new Map<string, DshSessionGeneration[]>();
    const natives = new Map<string, DshSessionGeneration>();
    for (const input of snapshot.generations) {
      const row = { ...input };
      const values = routes.get(row.logicalId) ?? [];
      values.push(row); routes.set(row.logicalId, values); natives.set(row.nativeId, row);
    }
    for (const values of routes.values()) values.sort((a,b) => a.generation-b.generation);
    this.routes = routes; this.natives = natives;
    this.staged = new Map(snapshot.pending.map(row => [row.nativeId, structuredClone(row)]));
  }
  current(logicalId: string): DshSessionGeneration {
    this.assertReadable();
    const rows = this.routes.get(logicalId);
    return { ...(rows?.[rows.length-1] ?? { logicalId, nativeId: logicalId, generation: 0,
      seedThroughSeq: -1, seedThroughTurn: 0, previousLastSeq: -1, previousLastTurn: 0 }) };
  }
  generations(logicalId: string): DshSessionGeneration[] {
    this.assertReadable();
    return this.routes.get(logicalId)?.map(row => ({ ...row })) ?? [this.current(logicalId)];
  }
  native(logicalId: string): string { return this.current(logicalId).nativeId; }
  logical(nativeId: string): string { this.assertReadable(); return this.natives.get(nativeId)?.logicalId ?? nativeId; }
  hidden(nativeId: string): boolean { this.assertReadable(); return this.staged.has(nativeId); }
  pending(): DshPendingGeneration[] { this.assertReadable(); return [...this.staged.values()].map(row => structuredClone(row)); }
  event(nativeId: string, event: DshEvent): DshEvent | null {
    this.assertReadable();
    const generation = this.natives.get(nativeId);
    return generation ? this.eventInGeneration(generation, event) : event;
  }
  forkCoordinates(logicalId: string, lastTurn?: number, beforeTurn?: number): { nativeId: string; lastTurn: number | undefined; beforeTurn: number | undefined } {
    const boundary = lastTurn ?? beforeTurn;
    const generations = this.generations(logicalId);
    const generation = boundary === undefined ? this.current(logicalId)
      : [...generations].reverse().find(generation => generation.generation === 0 || boundary > generation.previousLastTurn) ?? generations[0]!;
    const offset = generation.generation === 0 ? 0 : generation.previousLastTurn - generation.seedThroughTurn;
    return { nativeId: generation.nativeId, lastTurn: lastTurn === undefined ? undefined : lastTurn - offset,
      beforeTurn: beforeTurn === undefined ? undefined : beforeTurn - offset };
  }
  eventInGeneration(generation: DshSessionGeneration, event: DshEvent): DshEvent | null {
    this.assertReadable();
    if (generation.generation === 0) return event;
    if (event.seq <= generation.seedThroughSeq) return null;
    const offset = generation.previousLastSeq - generation.seedThroughSeq;
    const raw = event as DshEvent & { sourceEventSeqs?: number[]; surfaceOp?: any };
    const data = { ...(event.data as Record<string, unknown>) };
    if (typeof data.turn === "number") data.turn += generation.previousLastTurn - generation.seedThroughTurn;
    return { ...raw, seq: raw.seq + offset, data,
      ...(raw.sourceEventSeqs ? { sourceEventSeqs: raw.sourceEventSeqs.map(seq => seq + offset) } : {}),
      ...(raw.surfaceOp && typeof raw.surfaceOp === "object" ? { surfaceOp: { ...raw.surfaceOp, start: raw.surfaceOp.start + offset, end: raw.surfaceOp.end + offset } } : {}),
    };
  }
  /** Validate the bridge's native cut against the route captured before awaiting it. */
  resolveHistoryHead(generation: DshSessionGeneration, value: unknown): { nextSeq: number } | undefined {
    const current = this.current(generation.logicalId);
    if (current.nativeId !== generation.nativeId || current.generation !== generation.generation)
      throw new DshClientError("DSH_GENERATION_CHANGED", "DSH generation changed during describe; retry required", true);
    if (!value || typeof value !== "object") return undefined;
    const head = value as { sessionId?: unknown; nextSeq?: unknown };
    if (head.sessionId !== generation.nativeId || !Number.isSafeInteger(head.nextSeq) || Number(head.nextSeq) < 0)
      return undefined;
    if (generation.generation > 0 && Number(head.nextSeq) <= generation.seedThroughSeq) return undefined;
    const nextSeq = Number(head.nextSeq) + (generation.generation === 0 ? 0 : generation.previousLastSeq - generation.seedThroughSeq);
    return Number.isSafeInteger(nextSeq) && nextSeq >= 0 ? { nextSeq } : undefined;
  }
  frame(frame: DshStreamEnvelope): DshStreamEnvelope | null {
    this.assertReadable();
    const nativeId = frame.payload.sessionId;
    if (typeof nativeId !== "string") return frame;
    if (this.hidden(nativeId)) return null;
    const logicalId = this.logical(nativeId);
    if (this.native(logicalId) !== nativeId) return null; // Retired native producer.
    const payload: Record<string, unknown> = { ...frame.payload, sessionId: logicalId };
    if (payload.type === "session/event") {
      const event = this.event(nativeId, payload.event as DshEvent);
      if (!event) return null;
      payload.event = event;
    }
    return { ...frame, payload };
  }
}

export type DshRoutingReader = Pick<DshRoutingProjection, "current" | "generations" | "native" | "logical" | "hidden" | "pending" | "forkCoordinates" | "event" | "eventInGeneration" | "resolveHistoryHead" | "frame">;
export interface DshSessionRoutingPort extends DshRoutingReader {
  readonly outcome: import("@opencraft/sqlite-node").DatabaseOutcome;
  stage(logicalId: string, nativeId: string, intent?: NonNullable<DshPendingGeneration["intent"]>): void | Promise<void>;
  publish(expectedNativeId: string, next: DshSessionGeneration): void | Promise<void>;
  reconcile(logicalId: string, checkpoint: { sessionId: string; generation: number; seedThroughSeq?: number; seedThroughTurn?: number }): boolean | Promise<boolean>;
}
