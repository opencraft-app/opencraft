import type { AppServerClientRegistry, AppServerRequestLifecycleEvent } from "@opencraft/appserver-client";
import { readUserMessageDisplayText } from "@opencraft/chat-core";

export interface TurnCompletion {
  readonly hostId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly status: "completed" | "failed" | "interrupted";
  readonly threadTitle?: string;
  readonly userMessage?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function summary(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const text = Array.from(value.replace(/\s+/gu, " ").trim());
  return text.length > limit ? `${text.slice(0, limit - 1).join("")}…` : text.join("");
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

/** Bounded display projection of existing traffic, never a second Thread authority. */
class CompletionContext {
  private readonly titles = new Map<string, { name: string; preview: string; revision: number }>();
  private readonly messages = new Map<string, { items: Map<string, string>; live: boolean }>();
  private readonly requests = new Map<string | number, { revision: number; threadId: string | null; turnId: string | null; descending: boolean; firstPage: boolean }>();
  private titleRevision = 0;

  private thread(value: unknown, readRevision = this.titleRevision): void {
    const thread = record(value);
    if (typeof thread?.id !== "string" || !thread.id) return;
    const previous = this.titles.get(thread.id);
    if (!previous || previous.revision <= readRevision) {
      remember(this.titles, thread.id, { name: summary(thread.name, 80), preview: summary(thread.preview, 80), revision: previous?.revision ?? 0 }, 2048);
    }
    if (Array.isArray(thread.turns)) {
      for (const turn of thread.turns) this.turn(thread.id, turn, true);
    }
  }

  private item(threadId: string, turnId: string, value: unknown, live = true): void {
    const item = record(value);
    if (typeof item?.id !== "string" || !item.id) return;
    const text = readUserMessageDisplayText(item);
    if (text === null) return;
    const key = JSON.stringify([threadId, turnId]);
    const context = this.messages.get(key) ?? { items: new Map<string, string>(), live: false };
    if (!live && context.live) return;
    const items = context.items;
    // Updating an earlier Item must not move it after a more recent steer.
    items.set(item.id, summary(text, 160));
    if (items.size > 64) items.delete(items.keys().next().value!);
    remember(this.messages, key, { items, live: context.live || live }, 256);
  }

  private turn(threadId: string, value: unknown, seedOnly = false, prepend = false, replaceHistory = false): void {
    const turn = record(value);
    if (typeof turn?.id !== "string" || !turn.id || !Array.isArray(turn.items)) return;
    const key = JSON.stringify([threadId, turn.id]);
    // Late history responses cannot replace newer live input.
    const previous = this.messages.get(key);
    if (seedOnly && previous?.live) return;
    if (turn.itemsView === "full" || (seedOnly && (prepend || replaceHistory))) this.messages.delete(key);
    for (const item of turn.items) this.item(threadId, turn.id, item, !seedOnly);
    if (seedOnly && prepend && previous && !replaceHistory) {
      // Descending pagination brings older pages after the newer tail.
      const older = [...(this.messages.get(key)?.items ?? [])].filter(([id]) => !previous.items.has(id));
      const items = new Map([...older, ...previous.items]);
      while (items.size > 64) items.delete(items.keys().next().value!);
      remember(this.messages, key, { items, live: false }, 256);
    }
  }

  response(event: AppServerRequestLifecycleEvent): void {
    if (event.type === "started") {
      const params = record(event.params);
      remember(this.requests, event.id, { revision: this.titleRevision,
        threadId: typeof params?.threadId === "string" ? params.threadId : null,
        turnId: typeof params?.turnId === "string" ? params.turnId : null,
        descending: params?.sortDirection === "desc", firstPage: params?.cursor == null }, 256);
      return;
    }
    if (event.type === "failed" || event.type === "timed-out" || event.type === "aborted") {
      this.requests.delete(event.id);
      return;
    }
    if (event.type !== "completed") return;
    const request = this.requests.get(event.id);
    const readRevision = request?.revision ?? this.titleRevision;
    this.requests.delete(event.id);
    const result = record(event.result);
    if (event.method === "thread/list" && Array.isArray(result?.data)) {
      for (const thread of result.data) this.thread(thread, readRevision);
    } else if (["thread/start", "thread/read", "thread/resume", "thread/fork"].includes(event.method)) {
      this.thread(result?.thread, readRevision);
      const thread = record(result?.thread);
      const initial = record(result?.initialTurnsPage);
      if (typeof thread?.id === "string" && Array.isArray(initial?.data)) {
        for (const turn of initial.data) this.turn(thread.id, turn, true);
      }
    } else if (request?.threadId && event.method === "thread/turns/list" && Array.isArray(result?.data)) {
      for (const turn of result.data) this.turn(request.threadId, turn, true);
    } else if (request?.threadId && event.method === "thread/items/list" && Array.isArray(result?.data)) {
      const turns = new Map<string, unknown[]>();
      const entries = request.descending ? [...result.data].reverse() : result.data;
      for (const value of entries) {
        const entry = record(value);
        const turnId = typeof entry?.turnId === "string" ? entry.turnId : request.turnId;
        if (!turnId || (request.turnId && turnId !== request.turnId)) continue;
        const items = turns.get(turnId) ?? [];
        items.push(record(entry?.item) ?? entry);
        turns.set(turnId, items);
      }
      for (const [id, items] of turns) this.turn(request.threadId, { id, items }, true, request.descending, request.firstPage);
    }
  }

  notification(method: string, value: unknown): void {
    const params = record(value);
    if (method === "thread/started") this.thread(params?.thread);
    if (typeof params?.threadId !== "string" || !params.threadId) return;
    const threadId = params.threadId;
    if (method === "thread/name/updated") {
      const previous = this.titles.get(threadId);
      remember(this.titles, threadId, { name: summary(params.threadName, 80), preview: previous?.preview ?? "", revision: ++this.titleRevision }, 2048);
    } else if (method === "thread/deleted" || method === "thread/closed") {
      this.titles.delete(threadId);
      for (const key of this.messages.keys()) {
        if (JSON.parse(key)[0] === threadId) this.messages.delete(key);
      }
    } else if (method === "turn/started" || method === "turn/completed") {
      this.turn(threadId, params.turn);
    } else if ((method === "item/started" || method === "item/completed") && typeof params.turnId === "string" && params.turnId) {
      this.item(threadId, params.turnId, params.item);
    }
  }

  enrich(completion: TurnCompletion): TurnCompletion {
    const title = this.titles.get(completion.threadId);
    const threadTitle = title?.name || title?.preview;
    const items = this.messages.get(JSON.stringify([completion.threadId, completion.turnId]))?.items;
    const userMessage = items ? [...items.values()].at(-1) : undefined;
    return { ...completion, ...(threadTitle ? { threadTitle } : {}), ...(userMessage ? { userMessage } : {}) };
  }
}

/** Only a live terminal lifecycle event, never an Item phase or history read. */
export function readTurnCompletion(hostId: string, notification: { readonly method: string; readonly params: unknown }): TurnCompletion | null {
  if (notification.method !== "turn/completed") return null;
  const params = record(notification.params);
  const turn = record(params?.turn);
  if (typeof params?.threadId !== "string" || !params.threadId
    || typeof turn?.id !== "string" || !turn.id
    || (turn.status !== "completed" && turn.status !== "failed" && turn.status !== "interrupted")) return null;
  return { hostId, threadId: params.threadId, turnId: turn.id, status: turn.status };
}

export function turnCompletionKey(completion: TurnCompletion): string {
  return JSON.stringify([completion.hostId, completion.threadId, completion.turnId]);
}

/** Application-owned live observation survives View switches and Client replacement. */
export class TurnCompletionObserver {
  private readonly listeners = new Set<(completion: TurnCompletion) => void>();
  private readonly clients = new Map<string, () => void>();
  private readonly seen = new Set<string>();
  private readonly stopRegistry: () => void;
  private disposed = false;

  constructor(private readonly registry: Pick<AppServerClientRegistry, "get" | "getSnapshot" | "subscribeEvent">) {
    this.stopRegistry = registry.subscribeEvent(event => this.attach(event.hostId));
    for (const hostId of registry.getSnapshot().hostIds) this.attach(hostId);
  }

  subscribe = (listener: (completion: TurnCompletion) => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopRegistry();
    for (const stop of this.clients.values()) stop();
    this.clients.clear();
    this.listeners.clear();
    this.seen.clear();
  }

  private attach(hostId: string): void {
    this.clients.get(hostId)?.();
    this.clients.delete(hostId);
    const client = this.registry.get(hostId);
    if (!client || this.disposed) return;
    let context = new CompletionContext();
    let generation = client.connectionGeneration;
    const currentContext = () => {
      if (generation !== client.connectionGeneration) {
        generation = client.connectionGeneration;
        context = new CompletionContext();
      }
      return context;
    };
    const valid = () => !this.disposed && this.registry.get(hostId) === client;
    const stopResponses = client.subscribeRequestLifecycle(event => {
      if (valid()) currentContext().response(event);
    });
    const stopNotifications = client.subscribeNotification(notification => {
      if (!valid()) return;
      const projection = currentContext();
      projection.notification(notification.method, notification.params);
      const terminal = readTurnCompletion(hostId, notification);
      if (!terminal) return;
      const completion = projection.enrich(terminal);
      const key = turnCompletionKey(completion);
      if (this.seen.has(key)) return;
      this.seen.add(key);
      // Bounded Application memory; reconnect keeps the latest 2048 terminal identities.
      if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
      for (const listener of this.listeners) {
        try { listener(completion); } catch { /* Observers cannot block execution. */ }
      }
    });
    this.clients.set(hostId, () => { stopNotifications(); stopResponses(); });
  }
}
