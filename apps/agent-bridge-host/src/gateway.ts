import { isAbsolute } from 'node:path';
import { GatewayInbox } from './inbox.js';
import type { Receipt, OutboxEvent } from './types.js';
import type { CanonicalEvent } from '@opencraft/agent-bridge-assembler';
import { querySteerStatus, projectToAppServer } from '@opencraft/agent-bridge-assembler';

export interface BridgeGatewayOptions { url: string; token: string; serverId: string; inboxPath: string }
/** Gateway attachment may disappear while Host/Core continue. The durable inbox
 * owns cursor/dedup; this class only projects committed facts and joins IDs. */
export class BridgeGateway {
  readonly inbox: GatewayInbox;
  private pinned = new Set<string>();
  private routes = new Map<string, string>();
  private turns = new Map<string, Map<string, string>>();
  private items = new Map<string, Map<string, string>>();
  private replayInteractions?: Set<string>;
  private interactions = new Map<string, { threadId: string; frame: unknown }>();
  private cursor = 0;
  private pulling?: Promise<void>;
  constructor(readonly options: BridgeGatewayOptions, private event: (threadId: string, frame: unknown) => void) {
    if (typeof options.url !== 'string' || typeof options.token !== 'string' || options.token.length < 32 || typeof options.serverId !== 'string' || !options.serverId || options.serverId.length > 512 || typeof options.inboxPath !== 'string' || !isAbsolute(options.inboxPath)) throw Error('Invalid private bridge attachment configuration');
    let url: URL;
    try { url = new URL(options.url); } catch { throw Error('Invalid private bridge attachment URL'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/') throw Error('Private loopback Host attachment required');
    this.inbox = new GatewayInbox(options.inboxPath);
  }
  async rpc(path: string, body?: unknown): Promise<any> {
    const response = await fetch(this.options.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      const bodyValue = await response.json().catch(() => null) as { error?: unknown; code?: unknown; kind?: unknown } | null;
      const message = typeof bodyValue?.error === 'string' ? bodyValue.error : 'Bridge Host unavailable; query original request identity';
      throw Object.assign(Error(message), {
        ...(typeof bodyValue?.code === 'number' ? { code: bodyValue.code } : {}),
        ...(typeof bodyValue?.kind === 'string' ? { kind: bodyValue.kind } : {}),
      });
    }
    return response.json();
  }
  async open(): Promise<void> {
    const snapshot = await this.rpc('/snapshot');
    for (const row of snapshot.routes) { const route = JSON.parse(row.route); if (route[0] === this.options.serverId) this.pinned.add(route[1]); }
    for (const row of snapshot.nativeSessions) {
      const route = JSON.parse(row.route);
      if (route[0] === this.options.serverId) this.routes.set(route[1], row.native_id);
    }
    this.replayInteractions = new Set(snapshot.interactions.filter((row: any) => JSON.parse(row.route)[0] === this.options.serverId).map((row: any) => row.id));
    // Replay identities and pending request bodies; subscription recovery consults
    // the Host settlement ledger before offering an interaction again.
    for (;;) {
      const page = await this.inbox.read(this.cursor);
      if (!page.length) break;
      for (const row of page) { this.consume(row, false); this.cursor = row.seq; }
    }
    this.replayInteractions = undefined;
    await this.pull();
  }
  reserve(threadId: string): void { this.pinned.add(threadId); }
  owns(threadId: string): boolean { return this.pinned.has(threadId); }
  publicThread(nativeId: string): string | undefined { return [...this.routes].find(([, native]) => native === nativeId)?.[0]; }
  private consume(row: OutboxEvent, publish: boolean): void {
    const [serverId, threadId] = JSON.parse(row.route);
    if (serverId !== this.options.serverId) return;
    const payload = row.payload as { kind?: string; event?: CanonicalEvent; method?: string; params?: any };
    if (payload.method === 'thread/identity') { this.pinned.add(threadId); this.routes.set(threadId, payload.params.providerThreadId); }
    if (payload.method === 'interaction/resolved') this.interactions.delete(payload.params?.interactionId);
    if (payload.method === 'interaction/request' && typeof payload.params?.interactionId === 'string' && (!this.replayInteractions || this.replayInteractions.has(payload.params.interactionId))) this.interactions.set(payload.params.interactionId, { threadId, frame: { ...payload, params: { ...payload.params, threadId } } });
    if (payload.kind === 'canonical' && payload.event) {
      const event = payload.event;
      if (event.kind === 'turn.started') {
        const turns = this.turns.get(threadId) ?? new Map(); this.turns.set(threadId, turns);
        turns.set(event.nativeTurnId, event.turnId);
      }
      if (event.kind === 'item.started' || event.kind === 'item.completed') {
        const items = this.items.get(threadId) ?? new Map(); this.items.set(threadId, items);
        items.set(event.item.nativeKey, event.item.itemId);
      }
      if (publish) for (const frame of projectToAppServer([{ ...event, threadId }], { steerEvidenceDeclared: true, schemaVersion: 1 })) this.event(threadId, frame);
    } else if (publish && payload.method !== 'thread/identity') this.event(threadId, { ...payload, params: { ...payload.params, threadId } });
  }
  pull(): Promise<void> {
    return this.pulling ??= (async () => {
      await this.inbox.pull(this.options.url, this.options.token);
      for (;;) {
        const rows = await this.inbox.read(this.cursor);
        if (!rows.length) break;
        for (const row of rows) { this.consume(row, true); this.cursor = row.seq; }
      }
    })().finally(() => { this.pulling = undefined; });
  }
  /** Latest canonical turn opened on a bridge Thread, if its event was pulled. */
  async latestTurn(threadId: string): Promise<string | null> {
    await this.pull();
    const turns = this.turns.get(threadId);
    return turns === undefined ? null : [...turns.values()].at(-1) ?? null;
  }

  /** Canonical turn for a native turn id, as joined from `turn.started` events. */
  canonicalTurn(threadId: string, nativeTurnId: string): string | undefined {
    return this.turns.get(threadId)?.get(nativeTurnId);
  }

  async nativeSession(threadId: string): Promise<{ nativeId: string; restorable: boolean } | null> {
    const snapshot = await this.rpc('/snapshot');
    const route = JSON.stringify([this.options.serverId, threadId]);
    const row = snapshot.nativeSessions.find((entry: any) => entry.route === route);
    return row === undefined ? null : { nativeId: row.native_id, restorable: row.restorable === 1 };
  }

  /** Route rows owned by this attachment, including those created before restart. */
  async routeRows(): Promise<{ threadId: string; generation: string; nativeId: string | null; restorable: boolean }[]> {
    const snapshot = await this.rpc('/snapshot');
    const native = new Map(snapshot.nativeSessions.map((row: any) => [row.route, row]));
    return snapshot.routes.flatMap((row: any) => {
      const route = JSON.parse(row.route);
      if (route[0] !== this.options.serverId) return [];
      const nativeRow = native.get(row.route) as any;
      return [{ threadId: route[1], generation: row.generation, nativeId: nativeRow?.native_id ?? null, restorable: nativeRow?.restorable === 1 }];
    });
  }

  async pendingInteractions(threadId: string): Promise<unknown[]> {
    await this.pull();
    // Request bodies survive in the inbox; the Host ledger is the authority for
    // whether they remain pending after an accepted resolve/stop/close.
    const snapshot = await this.rpc('/snapshot');
    const pending = new Set<string>(), allPending = new Set<string>();
    for (const row of snapshot.interactions) {
      const route = JSON.parse(row.route);
      if (route[0] === this.options.serverId) { allPending.add(row.id); if (route[1] === threadId) pending.add(row.id); }
    }
    for (const id of this.interactions.keys()) if (!allPending.has(id)) this.interactions.delete(id);
    return [...this.interactions].filter(([id, entry]) => entry.threadId === threadId && pending.has(id)).map(([, entry]) => entry.frame);
  }
  async status(threadId: string, inputIds?: readonly string[]): Promise<unknown> {
    const snapshot = await this.rpc(`/thread?serverId=${encodeURIComponent(this.options.serverId)}&threadId=${encodeURIComponent(threadId)}`);
    return querySteerStatus(snapshot.state, { threadId, inputIds }, 1);
  }
  nativeTurn(threadId: string, turnId: string): string {
    const entry = [...(this.turns.get(threadId) ?? [])].find(([, canonical]) => canonical === turnId);
    if (!entry) throw Object.assign(Error('Target turn is no longer active'), { code: -32002, kind: 'stale-target' });
    return entry[0];
  }
  /** Rewrite protocol identities only; tool arguments/content are native bodies. */
  history(threadId: string, value: unknown): unknown {
    const object = (v: unknown): Record<string, any> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null;
    const turns = this.turns.get(threadId), items = this.items.get(threadId);
    const item = (row: Record<string, any>) => ({ ...row, id: items?.get(row.id) ?? row.id });
    const turn = (row: Record<string, any>) => ({ ...row, id: turns?.get(row.id) ?? row.id,
      ...(typeof row.rootTurnId === 'string' ? { rootTurnId: turns?.get(row.rootTurnId) ?? row.rootTurnId } : {}),
      ...(Array.isArray(row.items) ? { items: row.items.map((entry: unknown) => object(entry) ? item(object(entry)!) : entry) } : {}),
    });
    const thread = (row: Record<string, any>) => ({ ...row, id: threadId,
      ...(Array.isArray(row.turns) ? { turns: row.turns.map((entry: unknown) => object(entry) ? turn(object(entry)!) : entry) } : {}),
    });
    const entry = (raw: unknown): unknown => {
      const row = object(raw); if (!row) return raw;
      if (object(row.item) && typeof row.turnId === 'string') return { ...row, turnId: turns?.get(row.turnId) ?? row.turnId, item: item(row.item) };
      if (row.id === this.routes.get(threadId)) return thread(row);
      if (turns?.has(row.id)) return turn(row);
      if (items?.has(row.id)) return item(row);
      return row;
    };
    const row = object(value); if (!row) return value;
    const projected = entry(row) as Record<string, unknown>;
    return { ...projected,
      ...(object(row.thread) ? { thread: thread(row.thread) } : {}),
      ...(object(row.turn) ? { turn: turn(row.turn) } : {}),
      ...(typeof row.turnId === 'string' ? { turnId: turns?.get(row.turnId) ?? row.turnId } : {}),
      ...(typeof row.itemId === 'string' ? { itemId: items?.get(row.itemId) ?? row.itemId } : {}),
      ...(Array.isArray(row.data) ? { data: row.data.map(entry) } : {}),
    };
  }
  async command(threadId: string, commandId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const body = { serverId: this.options.serverId, threadId, commandId, method, params };
    try { await this.rpc('/command', body); }
    catch (error) { throw Object.assign(error as Error, { commandId }); }
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      const receipt = await this.rpc(`/command?id=${encodeURIComponent(commandId)}`) as Receipt;
      if (receipt.state === 'accepted') { await this.pull(); return receipt.response && 'result' in receipt.response ? receipt.response.result : null; }
      if (receipt.state === 'rejected' || receipt.state === 'unknown') {
        await this.pull();
        const error = receipt.state==='rejected' && receipt.response && 'error' in receipt.response ? receipt.response.error : { code: -32005, message: 'Native outcome unknown; query original command', kind: 'unknown-outcome' };
        throw Object.assign(Error(error.message), error, { commandId });
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw Object.assign(Error('Native outcome unknown; query original command'), { code: -32005, commandId });
  }
  async close(): Promise<void> { await this.pulling; await this.inbox.close(); }
}
