import { BRIDGE_HISTORY_SELECTION_LIMIT, isOutboxId, type BridgeHistorySelection, type Receipt, type OutboxEvent, type OutboxFence, type Generation } from "./types.js";
import { querySteerStatus, projectToAppServer, type CanonicalEvent } from "@opencraft/agent-bridge-assembler";
import { BRIDGE_MAX_FRAGMENTED_EVENT_BYTES, BRIDGE_OUTBOX_FRAGMENT_BYTES } from "@opencraft/agent-bridge-protocol";
import { THREAD_QUEUE_RECEIPT_TURN_LIMIT } from "@opencraft/appserver-protocol";
import type { BridgeInboxIdentity, BridgeInboxPendingInteraction } from "./inbox-store.js";

export type BridgeHostRequest = (path: string, body?: unknown) => Promise<Response>;
export type { BridgeHistorySelection } from "./types.js";

type BridgeSnapshot = {
  historyIdentityPages?: true;
  historyIdentitySelection?: true;
  historyPublicTurnBatch?: true;
  current: string | null;
  generations: { id: string; retired: number; config?: Generation }[];
  routes: { route: string; generation: string }[];
  nativeSessions: { route: string; native_id: string; restorable: number }[];
  interactions: { route: string; id: string }[];
};

type HistoryIdentities = { turns?: ReadonlyMap<string, string>; items?: ReadonlyMap<string, string> };
type HistoryIdentitySnapshot =
  | (HistoryIdentities & { fence?: undefined })
  | {
      turns: Map<string, string>;
      items: Map<string, string>;
      fence: { outboxId: string; through: number };
      selected: boolean;
    };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function selectHistoryIdentityIds(value: unknown, nativeTurnId?: string): BridgeHistorySelection | undefined {
  const nativeIds = new Set<string>();
  let overflow = false;
  const add = (id: unknown) => {
    if (typeof id !== "string" || overflow) return;
    if (!id || id.length > 512 || (nativeIds.size === BRIDGE_HISTORY_SELECTION_LIMIT && !nativeIds.has(id))) {
      overflow = true;
      return;
    }
    nativeIds.add(id);
  };
  const turn = (value: unknown) => {
    const row = record(value);
    add(row?.id);
    add(row?.rootTurnId);
    if (Array.isArray(row?.items)) for (const item of row.items) {
      if (overflow) break;
      add(record(item)?.id);
    }
  };
  const thread = (row: Record<string, unknown> | null) => {
    if (Array.isArray(row?.turns)) for (const entry of row.turns) {
      if (overflow) break;
      turn(entry);
    }
  };
  const entry = (row: Record<string, unknown> | null) => {
    turn(row);
    thread(row);
    add(row?.turnId);
    add(row?.itemId);
    add(record(row?.item)?.id);
  };
  const root = record(value);
  add(nativeTurnId);
  entry(root);
  turn(root?.turn);
  thread(record(root?.thread));
  if (Array.isArray(root?.data)) for (const row of root.data) {
    if (overflow) break;
    entry(record(row));
  }
  return overflow ? undefined : { nativeIds: [...nativeIds] };
}

async function readEventFragments(first: Record<string, unknown>, next: (offset: number) => Promise<unknown>): Promise<unknown> {
  const { total, digest, seq } = first;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 1 ||
      total > BRIDGE_MAX_FRAGMENTED_EVENT_BYTES || typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest) ||
      typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1)
    throw Error("Invalid outbox fragment metadata");
  const bytes = new Uint8Array(total);
  for (let offset = 0; offset < total; offset += BRIDGE_OUTBOX_FRAGMENT_BYTES) {
    const fragment = offset === 0 ? first : record(record(await next(offset))?.fragment);
    if (!fragment || fragment.seq !== seq || fragment.offset !== offset || fragment.total !== total ||
        fragment.digest !== digest || typeof fragment.data !== "string")
      throw Error("Outbox event changed during fragmented read");
    const chunk = atob(fragment.data);
    if (chunk.length !== Math.min(BRIDGE_OUTBOX_FRAGMENT_BYTES, total - offset))
      throw Error("Invalid outbox fragment length");
    for (let index = 0; index < chunk.length; index++) bytes[offset + index] = chunk.charCodeAt(index);
  }
  const checksum = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  if (Array.from(checksum, byte => byte.toString(16).padStart(2, "0")).join("") !== digest)
    throw Error("Outbox event digest changed");
  const row = record(JSON.parse(new TextDecoder().decode(bytes)));
  if (!row || row.seq !== seq) throw Error("Invalid fragmented outbox event");
  return row;
}

function retryableOutboxStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export class BridgeOutboxReadError extends Error {
  constructor(readonly status?: number, cause?: unknown) {
    super("Outbox read failed", { cause });
  }

  get retryable(): boolean {
    return this.status === undefined || retryableOutboxStatus(this.status);
  }
}

export class BridgeInteractionSnapshotIncomplete extends Error {
  constructor() {
    super("Pending interaction requests are still arriving");
    this.name = "BridgeInteractionSnapshotIncomplete";
  }
}

class BridgeOutboxAckError extends Error {
  constructor(readonly status?: number, cause?: unknown) {
    super("Outbox ack failed; committed projection remains queryable", { cause });
  }

  get retryable(): boolean {
    return this.status === undefined || retryableOutboxStatus(this.status);
  }
}

/** Node and Durable Objects acknowledge the same committed outbox cursor. */
export async function pullBridgeInbox(
  request: BridgeHostRequest,
  store: {
    cursor(): number | Promise<number>;
    apply(
      batch: readonly OutboxEvent[],
      fence?: OutboxFence,
    ): { cursor: number; inserted: OutboxEvent[] } | Promise<{ cursor: number; inserted: OutboxEvent[] }>;
  },
  { fenced = false, fragmentOversized = false, isReadInterrupted }: {
    fenced?: boolean;
    fragmentOversized?: boolean;
    isReadInterrupted?: (error: unknown) => boolean;
  } = {},
): Promise<OutboxEvent[]> {
  const path = `/events?cursor=${await store.cursor()}${fenced ? "&fenced=1" : ""}`;
  const read = async (offset: number): Promise<unknown> => {
    try {
      const response = await request(fragmentOversized ? `${path}&fragment=${offset}` : path);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new BridgeOutboxReadError(response.status);
      }
      return await response.json();
    } catch (error) {
      if (isReadInterrupted?.(error)) throw new BridgeOutboxReadError(undefined, error);
      throw error;
    }
  };
  const raw = await read(0);
  const page = fenced ? (raw as Partial<OutboxFence & { events: unknown }> | null) : null;
  let fence: OutboxFence | undefined;
  if (fenced) {
    if (!isOutboxId(page?.outboxId) || typeof page?.acknowledged !== "number" || typeof page?.high !== "number")
      throw Error("Invalid outbox producer fence");
    fence = { outboxId: page.outboxId, acknowledged: page.acknowledged, high: page.high };
  }
  const fragment = fragmentOversized ? record(record(raw)?.fragment) : null;
  const batch = fragment ? [await readEventFragments(fragment, async (offset) => {
    const page = await read(offset);
    if (fence && record(page)?.outboxId !== fence.outboxId)
      throw Error("Outbox producer changed during fragmented read");
    return page;
  })] : fenced ? page?.events : raw;
  if (
    !Array.isArray(batch) ||
    batch.some(
      (row) =>
        !row ||
        !Number.isSafeInteger(row.seq) ||
        typeof row.route !== "string" ||
        typeof row.generation !== "string" ||
        !("payload" in row),
    )
  )
    throw Error("Invalid outbox batch");
  const committed = await store.apply(batch, fence);
  if (fence && committed.cursor === fence.acknowledged) return committed.inserted;
  const ack = await request("/ack", { cursor: committed.cursor, ...(fence ? { outboxId: fence.outboxId } : {}) })
    .catch(error => { throw new BridgeOutboxAckError(undefined, error); });
  if (!ack.ok) throw new BridgeOutboxAckError(ack.status);
  return committed.inserted;
}

/** The bridge Host's private RPC and the owner's committed event inbox. */
export interface BridgeGatewayPorts {
  readonly serverId: string;
  request: BridgeHostRequest;
  inbox: {
    cursor(): Promise<number>;
    readIdentities(route: string, after: number, through: number, selection?: BridgeHistorySelection): Promise<BridgeInboxIdentity[]>;
    readAcknowledgedIdentities?(route: string, after: number, through: number, outboxId: string, selection?: BridgeHistorySelection): Promise<BridgeInboxIdentity[]>;
    readPendingInteractions(route: string, after: number, through: number, ids: readonly string[]): Promise<BridgeInboxPendingInteraction[]>;
    read(cursor: number): Promise<OutboxEvent[]>;
    pull(): Promise<unknown>;
    close(): Promise<void>;
  };
}

/** Gateway attachment may disappear while Host/Core continue. The durable inbox
 * owns cursor/dedup; this class only projects committed facts and joins IDs. */
export class BridgeGatewaySession {
  private pinned = new Set<string>();
  private routes = new Map<string, string>();
  private readonly publicIds = new Map<string, string>();
  private turns = new Map<string, Map<string, string>>();
  private items = new Map<string, Map<string, string>>();
  private retainedInteractions = new Map<string, Set<string>>();
  private readonly retainedInteractionReads = new Map<string, Promise<void>>();
  private readonly hydrated = new Map<string, Promise<void>>();
  private initialCursor = 0;
  private historyIdentityPages = false;
  private historyIdentitySelection = false;
  private historyPublicTurnBatch = false;
  private readonly interactions = new Map<string, Map<string, { seq: number; frame: unknown }>>();
  /** Settlements already projected from durable Host facts, awaiting their outbox event. */
  private readonly reconciledSettlements = new Set<string>();
  private cursor = 0;
  private pulling?: Promise<void>;
  constructor(
    private readonly ports: BridgeGatewayPorts,
    private event: (threadId: string, frame: unknown) => void,
  ) {}
  rpc(path: "/snapshot"): Promise<BridgeSnapshot>;
  rpc<T = unknown>(path: string, body?: unknown): Promise<T>;
  async rpc(path: string, body?: unknown): Promise<unknown> {
    const response = await this.ports.request(path, body);
    if (!response.ok) {
      const bodyValue = (await response.json().catch(() => null)) as {
        error?: unknown;
        code?: unknown;
        kind?: unknown;
        data?: unknown;
      } | null;
      const message =
        typeof bodyValue?.error === "string"
          ? bodyValue.error
          : "Bridge Host unavailable; query original request identity";
      throw Object.assign(Error(message), {
        ...(typeof bodyValue?.code === "number" ? { code: bodyValue.code } : {}),
        ...(typeof bodyValue?.kind === "string" ? { kind: bodyValue.kind } : {}),
        ...(bodyValue?.data !== undefined ? { data: bodyValue.data } : {}),
      });
    }
    return response.json();
  }
  /** Inputs the Host holds (queued, unknown, in flight), for maintenance draining. */
  maintenance(): Promise<{ queued: number; unknown: number; inFlight: number }> {
    return this.rpc("/maintenance");
  }
  async open({ live = true } = {}): Promise<void> {
    this.initialCursor = this.cursor = await this.ports.inbox.cursor();
    await this.loadRouteSnapshot();
    if (live) await this.pull();
  }
  /** Resolve public Thread identities for a passive metadata-only reader. */
  async loadRouteSnapshot(): Promise<boolean> {
    const snapshot = await this.rpc("/snapshot");
    this.historyIdentityPages = snapshot.historyIdentityPages === true;
    this.historyIdentitySelection = this.historyIdentityPages && snapshot.historyIdentitySelection === true;
    this.historyPublicTurnBatch = this.historyIdentitySelection && snapshot.historyPublicTurnBatch === true;
    for (const row of snapshot.routes) {
      const route = JSON.parse(row.route);
      if (route[0] === this.ports.serverId) this.pinned.add(route[1]);
    }
    for (const row of snapshot.nativeSessions) {
      const route = JSON.parse(row.route);
      if (route[0] === this.ports.serverId) this.bindIdentity(route[1], row.native_id);
    }
    const retained = new Map<string, Set<string>>();
    for (const { route, id } of snapshot.interactions) {
      const [serverId, threadId] = JSON.parse(route);
      if (serverId !== this.ports.serverId) continue;
      const ids = retained.get(threadId) ?? new Set<string>();
      ids.add(id);
      retained.set(threadId, ids);
    }
    this.retainedInteractions = retained;
    return this.historyIdentityPages;
  }
  private bindIdentity(threadId: string, nativeId: string): void {
    const previous = this.routes.get(threadId);
    if (previous && previous !== nativeId && this.publicIds.get(previous) === threadId) this.publicIds.delete(previous);
    this.routes.set(threadId, nativeId);
    this.publicIds.set(nativeId, threadId);
  }
  /** Restore only this route's identities for history projection and execution. */
  hydrateThread(threadId: string): Promise<void> {
    const existing = this.hydrated.get(threadId);
    if (existing) return existing;
    if (!this.initialCursor) return Promise.resolve();
    const route = JSON.stringify([this.ports.serverId, threadId]);
    const operation = (async () => {
      const turns = new Map<string, string>(), items = new Map<string, string>();
      let after = 0;
      while (after < this.initialCursor) {
        const page = await this.ports.inbox.readIdentities(route, after, this.initialCursor);
        if (!page.length) break;
        for (const row of page) {
          if (row.turn) turns.set(row.turn.nativeId, row.turn.id);
          if (row.item) items.set(row.item.nativeId, row.item.id);
          after = row.seq;
        }
      }
      if (turns.size) this.turns.set(threadId, turns);
      if (items.size) this.items.set(threadId, items);
    })().catch(error => {
      this.hydrated.delete(threadId);
      throw error;
    });
    this.hydrated.set(threadId, operation);
    return operation;
  }
  reserve(threadId: string): void {
    this.pinned.add(threadId);
  }
  owns(threadId: string): boolean {
    return this.pinned.has(threadId);
  }
  /** Native session of a bridge Thread, once its identity has been pulled. */
  nativeThread(threadId: string): string | undefined {
    return this.routes.get(threadId);
  }
  publicThread(nativeId: string): string | undefined {
    return this.publicIds.get(nativeId);
  }
  private storeInteraction(threadId: string, id: string, seq: number, frame: unknown): void {
    const thread = this.interactions.get(threadId) ?? new Map();
    thread.set(id, { seq, frame });
    this.interactions.set(threadId, thread);
  }
  private removeInteraction(threadId: string, id: string): boolean {
    this.retainedInteractions.get(threadId)?.delete(id);
    const thread = this.interactions.get(threadId);
    if (!thread?.delete(id)) return false;
    if (!thread.size) this.interactions.delete(threadId);
    return true;
  }
  private async consume(row: OutboxEvent): Promise<void> {
    const [serverId, threadId] = JSON.parse(row.route);
    if (serverId !== this.ports.serverId) return;
    const payload = record(row.payload) as {
      kind?: string;
      event?: CanonicalEvent;
      method?: string;
      params?: unknown;
    } | null;
    if (!payload) return;
    const params = record(payload.params);
    await this.hydrateThread(threadId);
    if (payload.method === "thread/identity") {
      this.pinned.add(threadId);
      if (typeof params?.providerThreadId === "string") this.bindIdentity(threadId, params.providerThreadId);
    }
    if (payload.method === "interaction/resolved" && typeof params?.interactionId === "string") {
      this.removeInteraction(threadId, params.interactionId);
      if (this.reconciledSettlements.delete(JSON.stringify([threadId, params.interactionId]))) return;
    }
    if (
      payload.method === "interaction/request" &&
      typeof params?.interactionId === "string"
    )
      this.storeInteraction(threadId, params.interactionId, row.seq, { ...payload, params: { ...params, threadId } });
    if (payload.kind === "canonical" && payload.event) {
      const event = payload.event;
      if (event.kind === "turn.started") {
        const turns = this.turns.get(threadId) ?? new Map();
        this.turns.set(threadId, turns);
        // A receipt can have seeded this mapping ahead of the replay cursor.
        turns.delete(event.nativeTurnId);
        turns.set(event.nativeTurnId, event.turnId);
      }
      if (event.kind === "item.started" || event.kind === "item.completed") {
        const items = this.items.get(threadId) ?? new Map();
        this.items.set(threadId, items);
        items.set(event.item.nativeKey, event.item.itemId);
      }
      for (const frame of projectToAppServer([{ ...event, threadId }], {
        steerEvidenceDeclared: true,
        schemaVersion: 1,
      }))
        this.event(threadId, frame);
    } else if (payload.method !== "thread/identity") {
      const params = this.history(threadId, payload.params) as Record<string, unknown> | undefined;
      this.event(threadId, { ...payload, params: { ...params, threadId } });
    }
  }
  pull(): Promise<void> {
    return (this.pulling ??= (async () => {
      let producerError: BridgeOutboxAckError | BridgeOutboxReadError | undefined;
      try {
        await this.ports.inbox.pull();
      } catch (error) {
        if (!(error instanceof BridgeOutboxAckError) &&
            !(error instanceof BridgeOutboxReadError && error.retryable)) throw error;
        // Another pull can already have committed events to this inbox. A
        // transient read failure must not hold those events behind the producer.
        producerError = error;
      }
      for (;;) {
        const rows = await this.ports.inbox.read(this.cursor);
        if (!rows.length) break;
        for (const row of rows) {
          await this.consume(row);
          this.cursor = row.seq;
        }
      }
      // Preserve read backoff and terminal acknowledgement handling. A retry
      // starts from the committed inbox cursor.
      if (producerError instanceof BridgeOutboxReadError || (producerError && !producerError.retryable))
        throw producerError;
    })().finally(() => {
      this.pulling = undefined;
    }));
  }
  /** Latest canonical turn opened on a bridge Thread, if its event was pulled. */
  async latestTurn(threadId: string): Promise<string | null> {
    await this.hydrateThread(threadId);
    await this.pull();
    const turns = this.turns.get(threadId);
    return turns === undefined ? null : ([...turns.values()].at(-1) ?? null);
  }

  /** Canonical turn for a native turn id, as joined from `turn.started` events. */
  canonicalTurn(threadId: string, nativeTurnId: string): string | undefined {
    return this.turns.get(threadId)?.get(nativeTurnId);
  }

  async nativeSession(threadId: string): Promise<{ nativeId: string; restorable: boolean } | null> {
    const snapshot = await this.rpc("/snapshot");
    const route = JSON.stringify([this.ports.serverId, threadId]);
    const row = snapshot.nativeSessions.find((entry) => entry.route === route);
    return row === undefined ? null : { nativeId: row.native_id, restorable: row.restorable === 1 };
  }

  /** Route rows owned by this attachment, including those created before restart. */
  async routeRows(): Promise<{ threadId: string; generation: string; nativeId: string | null; restorable: boolean }[]> {
    const snapshot = await this.rpc("/snapshot");
    const native = new Map(snapshot.nativeSessions.map((row) => [row.route, row]));
    return snapshot.routes.flatMap((row) => {
      const route = JSON.parse(row.route);
      if (route[0] !== this.ports.serverId) return [];
      const nativeRow = native.get(row.route);
      return [
        {
          threadId: route[1],
          generation: row.generation,
          nativeId: nativeRow?.native_id ?? null,
          restorable: nativeRow?.restorable === 1,
        },
      ];
    });
  }

  private projectInteractionSettlement(threadId: string, id: string): void {
    if (!this.removeInteraction(threadId, id)) return;
    this.reconciledSettlements.add(JSON.stringify([threadId, id]));
    this.event(threadId, { method: "interaction/resolved", params: { threadId, interactionId: id, reason: "resolved" } });
  }

  private restoreRetainedInteractions(threadId: string, interactionId?: string): Promise<void> {
    const key = JSON.stringify([threadId, interactionId ?? null]);
    const existing = this.retainedInteractionReads.get(key);
    if (existing) return existing;
    const ids = [...(this.retainedInteractions.get(threadId) ?? [])].filter(id =>
      (interactionId === undefined || id === interactionId) && !this.interactions.get(threadId)?.has(id));
    if (!ids.length || !this.initialCursor) return Promise.resolve();
    const route = JSON.stringify([this.ports.serverId, threadId]);
    const operation = (async () => {
      let after = 0;
      while (after < this.initialCursor) {
        const page = await this.ports.inbox.readPendingInteractions(route, after, this.initialCursor, ids);
        if (!page.length) break;
        for (const { seq, id, params } of page) {
          const current = this.interactions.get(threadId)?.get(id);
          if (this.retainedInteractions.get(threadId)?.has(id) && (!current || current.seq < seq)) {
            this.storeInteraction(threadId, id, seq, {
              method: "interaction/request", params: { ...params, threadId },
            });
          }
          after = seq;
        }
      }
    })().finally(() => this.retainedInteractionReads.delete(key));
    this.retainedInteractionReads.set(key, operation);
    return operation;
  }

  async pendingInteractions(threadId: string, interactionId?: string): Promise<unknown[]> {
    await Promise.all([this.hydrateThread(threadId), this.restoreRetainedInteractions(threadId, interactionId)]);
    let readFailure: BridgeOutboxReadError | undefined;
    // An already observed target needs only its ledger membership verified.
    if (interactionId === undefined || !this.interactions.get(threadId)?.has(interactionId)) {
      try {
        await this.pull();
      } catch (error) {
        if (!(error instanceof BridgeOutboxReadError && error.retryable)) throw error;
        readFailure = error;
      }
    }
    // Request bodies survive in the inbox; the Host ledger is the authority for
    // whether they remain pending after an accepted resolve/stop/close.
    const through = this.cursor;
    const matches = (id: string) => interactionId === undefined || id === interactionId;
    const observed = [...(this.interactions.get(threadId)?.keys() ?? [])].filter(matches);

    const snapshot = await this.rpc("/snapshot");
    const scope = JSON.stringify([this.ports.serverId, threadId]);
    const pending = new Set(snapshot.interactions.filter(row => row.route === scope && matches(row.id)).map(row => row.id));
    const frames: unknown[] = [];
    for (const [id, entry] of this.interactions.get(threadId) ?? []) {
      if (!matches(id)) continue;
      if (pending.delete(id)) frames.push(entry.frame);
      // The ledger snapshot cannot retire events that arrived after its request.
      else if (entry.seq <= through) this.projectInteractionSettlement(threadId, id);
    }
    // A known body that disappeared during the read was already retired by a
    // newer projection. Every other pending request must have its body in the inbox.
    for (const id of observed) pending.delete(id);
    if (pending.size) throw readFailure ?? new BridgeInteractionSnapshotIncomplete();
    return frames;
  }
  async status(threadId: string, inputIds?: readonly string[]): Promise<unknown> {
    const snapshot = await this.rpc<{ state: Parameters<typeof querySteerStatus>[0] }>(
      `/thread?serverId=${encodeURIComponent(this.ports.serverId)}&threadId=${encodeURIComponent(threadId)}`,
    );
    return querySteerStatus(snapshot.state, { threadId, inputIds }, 1);
  }
  nativeTurn(threadId: string, turnId: unknown): string {
    const entry = [...(this.turns.get(threadId) ?? [])].find(([, canonical]) => canonical === turnId);
    if (!entry) throw Object.assign(Error("Target turn is no longer active"), { code: -32002, kind: "stale-target" });
    return entry[0];
  }
  private async historyIdentities(
    threadId: string,
    { baseline, selection }: { baseline?: HistoryIdentitySnapshot; selection?: BridgeHistorySelection } = {},
  ): Promise<HistoryIdentitySnapshot> {
    if (!selection) await this.hydrateThread(threadId);
    if (!this.historyIdentityPages) {
      // Older producers have no route index. Do not project after only one page.
      const deadline = Date.now() + 10_000;
      do {
        const previous = this.cursor;
        await this.pull();
        if (previous === this.cursor) return { turns: this.turns.get(threadId), items: this.items.get(threadId) };
      } while (Date.now() < deadline);
      throw Error("Bridge history identity catch-up timed out");
    }

    const previous = baseline?.fence ? baseline : undefined;
    const incremental = previous && !previous.selected && !selection ? previous : undefined;
    const minimumHigh = Math.max(this.cursor, previous?.fence.through ?? 0);
    let after = incremental?.fence.through ?? (selection ? 0 : this.cursor);
    let through: number | undefined;
    let outboxId = previous?.fence.outboxId;
    const knownTurns = this.turns.get(threadId), knownItems = this.items.get(threadId);
    const turns = incremental?.turns ?? new Map(selection ? undefined : knownTurns);
    const items = incremental?.items ?? new Map(selection ? undefined : knownItems);
    for (const id of selection?.nativeIds ?? []) {
      const turn = knownTurns?.get(id), item = knownItems?.get(id);
      if (turn !== undefined) turns.set(id, turn);
      if (item !== undefined) items.set(id, item);
    }
    const route = JSON.stringify([this.ports.serverId, threadId]);
    const query = new URLSearchParams({ serverId: this.ports.serverId, threadId });
    const add = (row: BridgeInboxIdentity) => {
      if (row.turn) turns.set(row.turn.nativeId, row.turn.id);
      if (row.item) items.set(row.item.nativeId, row.item.id);
      after = row.seq;
    };

    for (;;) {
      query.set("after", String(after));
      if (through !== undefined) query.set("through", String(through));
      const page = await (selection
        ? this.rpc<OutboxFence & { identities: BridgeInboxIdentity[] }>("/history-identities", {
            serverId: this.ports.serverId, threadId, after, through, selection,
          })
        : this.rpc<OutboxFence & { identities: BridgeInboxIdentity[] }>(`/history-identities?${query}`));
      if (!isOutboxId(page?.outboxId) || (outboxId !== undefined && page.outboxId !== outboxId) ||
          !Number.isSafeInteger(page.high) || !Number.isSafeInteger(page.acknowledged) ||
          page.acknowledged < 0 || page.acknowledged > page.high ||
          page.high < Math.max(minimumHigh, through ?? after) || !Array.isArray(page.identities) || page.identities.length > 256)
        throw Error("Invalid Bridge history identity fence");
      outboxId ??= page.outboxId;
      through ??= page.high;
      const committed = Math.min(page.acknowledged, through);
      if (after < committed) {
        // Ack can advance between pages. The deleted prefix must already be in the inbox.
        const inbox = this.ports.inbox;
        if (!inbox.readAcknowledgedIdentities && await inbox.cursor() < committed)
          throw Error("Bridge history identity prefix is missing from the inbox");
        while (after < committed) {
          const local = inbox.readAcknowledgedIdentities
            ? await inbox.readAcknowledgedIdentities(route, after, committed, outboxId, selection)
            : await inbox.readIdentities(route, after, committed, selection);
          if (!local.length) break;
          for (const row of local) add(row);
        }
        after = committed;
      }
      for (const row of page.identities) {
        if (!Number.isSafeInteger(row?.seq) || row.seq <= after || row.seq > through)
          throw Error("Invalid Bridge history identity page");
        add(row);
      }
      if (page.identities.length < 256 || after === through)
        return { turns, items, fence: { outboxId, through }, selected: selection !== undefined };
    }
  }

  async readProjectedHistory(
    threadId: string,
    read: (nativeTurnId?: string) => Promise<unknown>,
    { turnId, metadataOnly = false }: { turnId?: unknown; metadataOnly?: boolean } = {},
  ): Promise<unknown> {
    let baseline: HistoryIdentitySnapshot | undefined;
    let nativeTurnId: string | undefined;
    if (turnId !== undefined) {
      if (typeof turnId !== "string" || !turnId || turnId.length > 512)
        throw Object.assign(Error("Invalid history Turn ID"), { code: -32602, kind: "invalid" });
      baseline = await this.historyIdentities(threadId, this.historyIdentitySelection
        ? { selection: { nativeIds: [], publicTurnId: turnId } } : undefined);
      // A native-only historical Turn remains scoped to the requested Thread.
      nativeTurnId = turnId;
      for (const [native, canonical] of baseline.turns ?? []) {
        if (canonical !== turnId) continue;
        nativeTurnId = native;
        break;
      }
      if (this.historyIdentitySelection && nativeTurnId === turnId) {
        for (const [native, canonical] of this.turns.get(threadId) ?? []) {
          if (canonical !== turnId) continue;
          nativeTurnId = native;
          break;
        }
      }
    }
    const result = await read(nativeTurnId);
    if (metadataOnly) return this.history(threadId, result);
    const selection = this.historyIdentitySelection ? selectHistoryIdentityIds(result, nativeTurnId) : undefined;
    const identities = await this.historyIdentities(threadId, { baseline, selection });
    if (baseline?.fence && baseline.selected && nativeTurnId !== undefined && nativeTurnId !== turnId &&
        identities.turns?.get(nativeTurnId) !== turnId)
      throw Object.assign(Error("History Turn identity changed"), { code: -32002, kind: "stale-target" });
    return this.history(threadId, result, identities);
  }

  catalogThread(value: unknown): unknown {
    const row = record(value);
    if (!row || typeof row.id !== "string") return value;
    const related = (id: unknown) => typeof id === "string" ? this.publicThread(id) ?? id : id;
    return {
      ...row,
      id: related(row.id),
      ...(Object.hasOwn(row, "parentThreadId") ? { parentThreadId: related(row.parentThreadId) } : {}),
      ...(Object.hasOwn(row, "forkedFromId") ? { forkedFromId: related(row.forkedFromId) } : {}),
    };
  }

  /** Rewrite protocol identities only; tool arguments/content are native bodies. */
  history(threadId: string, value: unknown, { turns, items }: HistoryIdentities = {
    turns: this.turns.get(threadId), items: this.items.get(threadId),
  }): unknown {
    const item = (row: Record<string, unknown>) => ({
      ...row,
      id: typeof row.id === "string" ? (items?.get(row.id) ?? row.id) : row.id,
    });
    const turn = (row: Record<string, unknown>) => ({
      ...row,
      id: typeof row.id === "string" ? (turns?.get(row.id) ?? row.id) : row.id,
      ...(typeof row.rootTurnId === "string" ? { rootTurnId: turns?.get(row.rootTurnId) ?? row.rootTurnId } : {}),
      ...(Array.isArray(row.items)
        ? {
            items: row.items.map((value: unknown) => {
              const entry = record(value);
              return entry ? item(entry) : value;
            }),
          }
        : {}),
    });
    const thread = (row: Record<string, unknown>) => ({
      ...record(this.catalogThread(row)),
      id: threadId,
      ...(Array.isArray(row.turns)
        ? {
            turns: row.turns.map((value: unknown) => {
              const entry = record(value);
              return entry ? turn(entry) : value;
            }),
          }
        : {}),
    });
    const project = (row: Record<string, unknown>): Record<string, unknown> => {
      const nestedItem = record(row.item);
      if (typeof row.turnId === "string" && typeof row.itemId === "string")
        return { ...row, turnId: turns?.get(row.turnId) ?? row.turnId, itemId: items?.get(row.itemId) ?? row.itemId };
      if (nestedItem && typeof row.turnId === "string")
        return { ...row, turnId: turns?.get(row.turnId) ?? row.turnId, item: item(nestedItem) };
      if (typeof row.id !== "string") return row;
      if (row.id === this.routes.get(threadId)) return thread(row);
      if (turns?.has(row.id)) return turn(row);
      if (items?.has(row.id)) return item(row);
      return row;
    };
    const row = record(value);
    if (!row) return value;
    const nestedThread = record(row.thread);
    const nestedTurn = record(row.turn);
    return {
      ...project(row),
      ...(nestedThread ? { thread: thread(nestedThread) } : {}),
      ...(nestedTurn ? { turn: turn(nestedTurn) } : {}),
      ...(typeof row.turnId === "string" ? { turnId: turns?.get(row.turnId) ?? row.turnId } : {}),
      ...(typeof row.itemId === "string" ? { itemId: items?.get(row.itemId) ?? row.itemId } : {}),
      ...(Array.isArray(row.data)
        ? {
            data: row.data.map((value: unknown) => {
              const entry = record(value);
              return entry ? project(entry) : value;
            }),
          }
        : {}),
    };
  }
  /** Host-owned queue of a bridge Thread; changes arrive as thread/queue/changed events. */
  async queue(threadId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.hydrateThread(threadId);
    if (method === "thread/queue/list") return this.queueList(threadId, params);
    const result = await this.rpc("/queue", { serverId: this.ports.serverId, threadId, method, params });
    await this.pull().catch(() => {}); // The queue owner has already committed its result.
    return result;
  }

  private async queueList(threadId: string, params: Record<string, unknown>): Promise<unknown> {
    const scope = params.receiptTurnIds;
    const known = this.turns.get(threadId);
    let selected: ReadonlyMap<string, string> | undefined;
    if (Array.isArray(scope) && scope.length && scope.length <= THREAD_QUEUE_RECEIPT_TURN_LIMIT &&
        scope.every((id): id is string => typeof id === "string" && id.length > 0)) {
      const nativeByPublic = new Map<string, string>();
      for (const [native, canonical] of known ?? []) nativeByPublic.set(canonical, native);
      const missing = [...new Set(scope.filter(id => !nativeByPublic.has(id) && id.length <= 512))];
      if (this.historyPublicTurnBatch && missing.length) {
        const identities = await this.historyIdentities(threadId, {
          selection: { nativeIds: [], publicTurnIds: missing },
        }).catch(() => undefined);
        selected = identities?.turns;
        for (const [native, canonical] of selected ?? []) nativeByPublic.set(canonical, native);
      }
      params = { ...params, receiptTurnIds: scope.map(id => nativeByPublic.get(id) ?? id) };
    }
    const result = await this.rpc("/queue", { serverId: this.ports.serverId, threadId, method: "thread/queue/list", params });
    const page = record(result);
    if (!page || !Array.isArray(page.steering)) return result;
    const publicTurn = (value: unknown) => typeof value === "string"
      ? selected?.get(value) ?? known?.get(value) ?? value
      : value;
    return {
      ...page,
      steering: page.steering.map(value => {
        const row = record(value);
        if (!row) return value;
        const delivery = record(row.delivery);
        return {
          ...row,
          targetTurnId: publicTurn(row.targetTurnId),
          ...(delivery ? { delivery: { ...delivery, targetTurnId: publicTurn(delivery.targetTurnId) } } : {}),
        };
      }),
    };
  }
  async observe(threadId: string, params: Record<string, unknown>): Promise<unknown> {
    const metadataOnly = params.view === "thread" && params.includeTurns !== true;
    return this.readProjectedHistory(threadId, async nativeTurnId => {
      const result = await this.rpc("/observe", {
        serverId: this.ports.serverId,
        threadId,
        method: "history/read",
        params: nativeTurnId === undefined ? params : { ...params, turnId: nativeTurnId },
      });
      if (!metadataOnly) return result;
      const value = record(result);
      const thread = record(value?.thread);
      return thread ? { ...value, thread: { ...thread, turns: [] } } : result;
    }, { turnId: params.turnId, metadataOnly });
  }
  async command(
    threadId: string,
    commandId: string,
    method: string,
    params: Record<string, unknown>,
    beforeDispatch?: () => void,
  ): Promise<unknown> {
    await this.hydrateThread(threadId);
    const body = { serverId: this.ports.serverId, threadId, commandId, method, params };
    beforeDispatch?.();
    try {
      await this.rpc("/command", body);
    } catch (error) {
      throw Object.assign(error as Error, { commandId });
    }
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      const receipt = (await this.rpc(`/command?id=${encodeURIComponent(commandId)}`)) as Receipt;
      if (receipt.state === "accepted") {
        const identities = receipt.identities;
        if (identities?.nativeThreadId !== undefined) {
          this.pinned.add(threadId);
          this.bindIdentity(threadId, identities.nativeThreadId);
        }
        if (identities?.turn !== undefined) {
          const turns = this.turns.get(threadId) ?? new Map<string, string>();
          turns.set(identities.turn.nativeId, identities.turn.id);
          this.turns.set(threadId, turns);
        }
        // The accepted resolution and its ledger deletion share one Host transaction.
        if (method === "interaction/resolve" && typeof params.interactionId === "string")
          this.projectInteractionSettlement(threadId, params.interactionId);
        // The owner polling loop delivers events for commands with receipt identities.
        // Other operations and legacy Hosts still rely on the ordered event read.
        else if (identities === undefined) await this.pull().catch(() => {});
        return receipt.response && "result" in receipt.response ? receipt.response.result : null;
      }
      if (receipt.state === "rejected" || receipt.state === "unknown") {
        // Native start evidence can precede an ambiguous failure.
        await this.pull().catch(() => {});
        const error =
          receipt.state === "rejected" && receipt.response && "error" in receipt.response
            ? receipt.response.error
            : { code: -32005, message: "Native outcome unknown; query original command", kind: "unknown-outcome" };
        throw Object.assign(Error(error.message), error, { commandId });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Object.assign(Error("Native outcome unknown; query original command"), { code: -32005, commandId });
  }
  async close(): Promise<void> {
    await this.pulling?.catch(() => {});
    await this.ports.inbox.close();
  }
}
