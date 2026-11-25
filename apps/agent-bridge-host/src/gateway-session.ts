import { isOutboxId, type Receipt, type OutboxEvent, type OutboxFence, type Generation } from "./types.js";
import { querySteerStatus, projectToAppServer, type CanonicalEvent } from "@opencraft/agent-bridge-assembler";

export type BridgeHostRequest = (path: string, body?: unknown) => Promise<Response>;

type BridgeSnapshot = {
  current: string | null;
  generations: { id: string; retired: number; config?: Generation }[];
  routes: { route: string; generation: string }[];
  nativeSessions: { route: string; native_id: string; restorable: number }[];
  interactions: { route: string; id: string }[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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
  fenced = false,
): Promise<OutboxEvent[]> {
  const response = await request(`/events?cursor=${await store.cursor()}${fenced ? "&fenced=1" : ""}`);
  if (!response.ok) throw Error("Outbox read failed");
  const raw: unknown = await response.json();
  const page = fenced ? (raw as Partial<OutboxFence & { events: unknown }> | null) : null;
  let fence: OutboxFence | undefined;
  if (fenced) {
    if (!isOutboxId(page?.outboxId) || typeof page?.acknowledged !== "number" || typeof page?.high !== "number")
      throw Error("Invalid outbox producer fence");
    fence = { outboxId: page.outboxId, acknowledged: page.acknowledged, high: page.high };
  }
  const batch = fenced ? page?.events : raw;
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
  const ack = await request("/ack", { cursor: committed.cursor, ...(fence ? { outboxId: fence.outboxId } : {}) });
  if (!ack.ok) throw Error("Outbox ack failed; committed projection remains queryable");
  return committed.inserted;
}

/** The bridge Host's private RPC and the owner's committed event inbox. */
export interface BridgeGatewayPorts {
  readonly serverId: string;
  request: BridgeHostRequest;
  inbox: {
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
  private turns = new Map<string, Map<string, string>>();
  private items = new Map<string, Map<string, string>>();
  private replayInteractions?: Set<string>;
  private interactions = new Map<string, { threadId: string; frame: unknown }>();
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
      } | null;
      const message =
        typeof bodyValue?.error === "string"
          ? bodyValue.error
          : "Bridge Host unavailable; query original request identity";
      throw Object.assign(Error(message), {
        ...(typeof bodyValue?.code === "number" ? { code: bodyValue.code } : {}),
        ...(typeof bodyValue?.kind === "string" ? { kind: bodyValue.kind } : {}),
      });
    }
    return response.json();
  }
  /** Inputs the Host holds (queued, unknown, in flight), for maintenance draining. */
  maintenance(): Promise<{ queued: number; unknown: number; inFlight: number }> {
    return this.rpc("/maintenance");
  }
  async open(): Promise<void> {
    const snapshot = await this.rpc("/snapshot");
    for (const row of snapshot.routes) {
      const route = JSON.parse(row.route);
      if (route[0] === this.ports.serverId) this.pinned.add(route[1]);
    }
    for (const row of snapshot.nativeSessions) {
      const route = JSON.parse(row.route);
      if (route[0] === this.ports.serverId) this.routes.set(route[1], row.native_id);
    }
    this.replayInteractions = new Set(
      snapshot.interactions.filter((row) => JSON.parse(row.route)[0] === this.ports.serverId).map((row) => row.id),
    );
    // Replay identities and pending request bodies; subscription recovery consults
    // the Host settlement ledger before offering an interaction again.
    for (;;) {
      const page = await this.ports.inbox.read(this.cursor);
      if (!page.length) break;
      for (const row of page) {
        this.consume(row, false);
        this.cursor = row.seq;
      }
    }
    this.replayInteractions = undefined;
    await this.pull();
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
    return [...this.routes].find(([, native]) => native === nativeId)?.[0];
  }
  private consume(row: OutboxEvent, publish: boolean): void {
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
    if (payload.method === "thread/identity") {
      this.pinned.add(threadId);
      if (typeof params?.providerThreadId === "string") this.routes.set(threadId, params.providerThreadId);
    }
    if (payload.method === "interaction/resolved" && typeof params?.interactionId === "string")
      this.interactions.delete(params.interactionId);
    if (
      payload.method === "interaction/request" &&
      typeof params?.interactionId === "string" &&
      (!this.replayInteractions || this.replayInteractions.has(params.interactionId))
    )
      this.interactions.set(params.interactionId, {
        threadId,
        frame: { ...payload, params: { ...params, threadId } },
      });
    if (payload.kind === "canonical" && payload.event) {
      const event = payload.event;
      if (event.kind === "turn.started") {
        const turns = this.turns.get(threadId) ?? new Map();
        this.turns.set(threadId, turns);
        turns.set(event.nativeTurnId, event.turnId);
      }
      if (event.kind === "item.started" || event.kind === "item.completed") {
        const items = this.items.get(threadId) ?? new Map();
        this.items.set(threadId, items);
        items.set(event.item.nativeKey, event.item.itemId);
      }
      if (publish)
        for (const frame of projectToAppServer([{ ...event, threadId }], {
          steerEvidenceDeclared: true,
          schemaVersion: 1,
        }))
          this.event(threadId, frame);
    } else if (publish && payload.method !== "thread/identity") {
      const params = this.history(threadId, payload.params) as Record<string, unknown> | undefined;
      this.event(threadId, { ...payload, params: { ...params, threadId } });
    }
  }
  pull(): Promise<void> {
    return (this.pulling ??= (async () => {
      await this.ports.inbox.pull();
      for (;;) {
        const rows = await this.ports.inbox.read(this.cursor);
        if (!rows.length) break;
        for (const row of rows) {
          this.consume(row, true);
          this.cursor = row.seq;
        }
      }
    })().finally(() => {
      this.pulling = undefined;
    }));
  }
  /** Latest canonical turn opened on a bridge Thread, if its event was pulled. */
  async latestTurn(threadId: string): Promise<string | null> {
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

  async pendingInteractions(threadId: string): Promise<unknown[]> {
    await this.pull();
    // Request bodies survive in the inbox; the Host ledger is the authority for
    // whether they remain pending after an accepted resolve/stop/close.
    const snapshot = await this.rpc("/snapshot");
    const pending = new Set<string>(),
      allPending = new Set<string>();
    for (const row of snapshot.interactions) {
      const route = JSON.parse(row.route);
      if (route[0] === this.ports.serverId) {
        allPending.add(row.id);
        if (route[1] === threadId) pending.add(row.id);
      }
    }
    for (const id of this.interactions.keys()) if (!allPending.has(id)) this.interactions.delete(id);
    return [...this.interactions]
      .filter(([id, entry]) => entry.threadId === threadId && pending.has(id))
      .map(([, entry]) => entry.frame);
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
  /** Rewrite protocol identities only; tool arguments/content are native bodies. */
  history(threadId: string, value: unknown): unknown {
    const turns = this.turns.get(threadId);
    const items = this.items.get(threadId);
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
      ...row,
      id: threadId,
      ...(typeof row.forkedFromId === "string"
        ? { forkedFromId: this.publicThread(row.forkedFromId) ?? row.forkedFromId }
        : {}),
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
    const result = await this.rpc("/queue", { serverId: this.ports.serverId, threadId, method, params });
    await this.pull();
    return result;
  }
  async observe(threadId: string, params: Record<string, unknown>): Promise<unknown> {
    const result = await this.rpc("/observe", {
      serverId: this.ports.serverId,
      threadId,
      method: "history/read",
      params,
    });
    await this.pull();
    return result;
  }
  async command(
    threadId: string,
    commandId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const body = { serverId: this.ports.serverId, threadId, commandId, method, params };
    try {
      await this.rpc("/command", body);
    } catch (error) {
      throw Object.assign(error as Error, { commandId });
    }
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      const receipt = (await this.rpc(`/command?id=${encodeURIComponent(commandId)}`)) as Receipt;
      if (receipt.state === "accepted") {
        await this.pull();
        return receipt.response && "result" in receipt.response ? receipt.response.result : null;
      }
      if (receipt.state === "rejected" || receipt.state === "unknown") {
        await this.pull();
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
    await this.pulling;
    await this.ports.inbox.close();
  }
}
