import type { MessageSender } from "@opencraft/appserver-protocol";
import type { ThreadMetadataContext, ThreadMetadataExtension } from "@opencraft/appserver-client";
import { WorkerOwner, WorkerOwnerUnavailable, ownerEntry } from "@opencraft/worker-owner";
import {
  LEGACY_THREAD_PARTICIPANTS_CHANGED,
  LEGACY_THREAD_PARTICIPANTS_LIST,
  THREAD_PARTICIPANTS_BATCH_LIMIT,
  THREAD_PARTICIPANTS_CHANGED,
  THREAD_PARTICIPANTS_LIST,
  THREAD_PARTICIPANTS_VERSION,
  isParticipantName,
  type ThreadParticipants,
} from "./contract";
import type {
  ParticipantProjection,
  ParticipantStoreData,
  ParticipantStoreMethods,
  ParticipantWrite,
} from "./store-protocol";

type Value = Record<string, unknown>;
const record = (value: unknown): Value =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Value) : {};
const string = (value: unknown): string => (typeof value === "string" ? value : "");
const USER_MESSAGE_TYPES = new Set(["userMessage", "UserMessage", "steeringUserMessage"]);

function messageIds(value: unknown): string[] {
  const source = record(value);
  const ids: string[] = [];
  const visit = (item: unknown) => {
    const value = record(item);
    if (USER_MESSAGE_TYPES.has(string(value.type))) {
      const id = string(value.clientId) || string(value.client_id) || string(value.clientUserMessageId);
      if (id) ids.push(id);
    }
  };
  visit(source.item);
  if (Array.isArray(source.items)) source.items.forEach(visit);
  return ids;
}

export interface ThreadParticipantsMetadataOptions {
  /** Also serve, advertise and notify the deprecated pre-core wire names. Defaults to true. */
  readonly legacyAliases?: boolean;
  /** Threads whose committed projection stays in memory. Defaults to 512. */
  readonly cacheLimit?: number;
  /** Storage Worker entry; defaults to `thread-participants.worker.ts` / `thread-participants-worker.mjs` beside this module. */
  readonly workerEntry?: URL;
}

interface Projection extends ParticipantProjection {
  /** Message IDs already committed for this Thread; repeated observations send nothing. */
  readonly recorded: Set<string>;
}
const RECORDED_LIMIT = 4096;

/**
 * Core participants projection over the Host's thread identity tables. A
 * verified sender of an accepted user message is a participant; a sender
 * binding alone is not. The Hub's access session gates every requested Thread.
 *
 * A storage Worker owns the only SQLite connection this provider uses (a WAL
 * connection borrowed from the Host's migrated database). This thread keeps a
 * bounded projection of committed state: known messages cost no IO and no
 * notification; other observations are posted to the Worker in order and
 * announced only after it acknowledges the commit. If the Worker fails, the
 * provider fails closed; nothing runs on this thread instead.
 */
export class ThreadParticipantsMetadata implements ThreadMetadataExtension {
  readonly methods: readonly string[];
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly #changed: readonly string[];
  readonly #cache = new Map<string, Projection>();
  readonly #inflight = new Map<string, Map<string, number>>();
  readonly #cacheLimit: number;
  readonly #owner: Promise<WorkerOwner<ParticipantStoreMethods>>;
  #failure: Error | null = null;
  #closing: Promise<void> | null = null;
  /** Settles after the newest posted write was acknowledged and projected. */
  #tail: Promise<void> = Promise.resolve();

  constructor(
    readonly context: ThreadMetadataContext,
    options: ThreadParticipantsMetadataOptions = {},
  ) {
    const legacy = options.legacyAliases !== false;
    this.methods = legacy ? [THREAD_PARTICIPANTS_LIST, LEGACY_THREAD_PARTICIPANTS_LIST] : [THREAD_PARTICIPANTS_LIST];
    this.capabilities = Object.fromEntries(
      this.methods.map((method) => [method, { version: THREAD_PARTICIPANTS_VERSION }]),
    );
    this.#changed = legacy
      ? [THREAD_PARTICIPANTS_CHANGED, LEGACY_THREAD_PARTICIPANTS_CHANGED]
      : [THREAD_PARTICIPANTS_CHANGED];
    this.#cacheLimit = Math.max(1, options.cacheLimit ?? 512);
    if (!context.databasePath) throw new Error("Thread participants need the Host database file");
    const data: ParticipantStoreData = { path: context.databasePath };
    this.#owner = WorkerOwner.open<ParticipantStoreMethods>(
      options.workerEntry ?? ownerEntry(import.meta.url, "thread-participants"),
      { name: "Thread participant storage", workerData: data, onFailure: (error) => this.#fail(error) },
    ).then(({ owner }) => owner);
    this.#owner.catch((error: unknown) => this.#fail(error));
  }

  /** The error that closed this provider, if its storage Worker failed. */
  get unavailable(): Error | null {
    return this.#failure;
  }

  /** Resolves once every observation posted so far was committed (or failed) and announced. */
  settled(): Promise<void> {
    return this.#tail;
  }

  supports(method: string): boolean {
    return this.methods.includes(method);
  }

  async request(method: string, params: Value): Promise<unknown> {
    if (!this.supports(method)) throw new Error("Unsupported participant method");
    if (
      !Array.isArray(params.threadIds) ||
      params.threadIds.length > THREAD_PARTICIPANTS_BATCH_LIMIT ||
      params.threadIds.some((id) => typeof id !== "string" || !id || id.length > 4096)
    )
      throw new Error("Invalid participant query");
    const ids = [...new Set(params.threadIds as string[])];
    // A row stays answerable even when loading others evicts it from the bounded projection.
    const loaded = new Map<string, ParticipantProjection>();
    for (const id of ids) {
      const cached = this.#cache.get(id);
      if (cached) loaded.set(id, cached);
    }
    const missing = ids.filter((id) => !loaded.has(id));
    if (missing.length) {
      // Queued behind every earlier write, so a reader sees what was announced.
      for (const projection of await this.#call("load", missing)) {
        loaded.set(projection.threadId, this.#commit(projection) ?? projection);
      }
    } else this.#available();
    const data: ThreadParticipants[] = ids.map((id) => {
      const { threadId, revision, participants, creator } = this.#cache.get(id) ?? loaded.get(id)!;
      return { threadId, revision, participants, creator };
    });
    return { data, errors: [] };
  }

  observeResult(method: string, params: Value, result: unknown, sender?: MessageSender | null): void {
    const value = record(result),
      thread = record(value.thread);
    const threadId = string(thread.id) || string(params.threadId);
    if (!threadId || this.#stopped()) return;
    if ((method === "thread/start" || method === "thread/fork") && sender !== undefined) {
      if (sender && (sender.kind !== "employee" || !isParticipantName(sender.loginName)))
        throw new Error("Invalid creation identity");
      this.#write(threadId, this.#call("recordCreator", threadId, sender?.loginName ?? null));
    }
    if (method === "thread/delete") {
      this.#write(threadId, this.#call("forget", threadId), true);
      return;
    }
    // Copied history keeps its authors without making them participants of the fork.
    if (method === "thread/fork") {
      this.#apply(threadId, [], true);
      return;
    }
    // A successful native admission confirms this input without a history read.
    if (
      (method === "turn/start" && string(record(value.turn).id)) ||
      (method === "turn/steer" && (string(value.turnId) || string(record(value.turn).id)))
    ) {
      const id = string(params.clientUserMessageId);
      if (id) this.#apply(threadId, [id]);
    }
    const turns = Array.isArray(thread.turns) ? thread.turns : Array.isArray(value.turns) ? value.turns : [];
    for (const turn of turns) this.#apply(threadId, messageIds(turn));
    // Reuse accepted items in an already requested history page, including
    // those whose live notification was missed. Never request history here.
    const page = method === "thread/turns/list" || method === "thread/items/list"
      ? value.data : record(value.initialTurnsPage).data;
    if (Array.isArray(page)) this.#apply(threadId, page.flatMap(messageIds));
    this.#apply(threadId, [...messageIds(value), ...messageIds(value.turn)]);
  }

  observeNotification(message: Value): void {
    if (this.#stopped()) return;
    const params = record(message.params),
      threadId = string(params.threadId);
    if (threadId) this.#apply(threadId, [...messageIds(params), ...messageIds(params.turn)]);
  }

  /** Commits every write posted before it, then stops the storage Worker. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    return (this.#closing = (async () => {
      const owner = await this.#owner.catch(() => null);
      await owner?.close().catch(() => undefined);
      this.#cache.clear();
    })());
  }

  #stopped(): boolean {
    return this.#failure !== null || this.#closing !== null;
  }

  #available(): void {
    if (this.#failure)
      throw new WorkerOwnerUnavailable("Thread participant storage is unavailable", { cause: this.#failure });
    if (this.#closing) throw new WorkerOwnerUnavailable("Thread participant storage is closed");
  }

  #call<K extends keyof ParticipantStoreMethods>(
    method: K,
    ...args: Parameters<ParticipantStoreMethods[K]>
  ): Promise<ReturnType<ParticipantStoreMethods[K]>> {
    try {
      this.#available();
    } catch (error) {
      return Promise.reject(error);
    }
    // `then` callbacks run in registration order, so calls reach the Worker in the order made.
    return this.#owner.then((owner) =>
      (owner.call[method] as (...values: unknown[]) => Promise<ReturnType<ParticipantStoreMethods[K]>>)(...args),
    );
  }

  #fail(error: unknown): void {
    if (this.#failure) return;
    this.#failure = error instanceof Error ? error : new Error(String(error));
    this.#cache.clear();
    this.#inflight.clear();
  }

  /** Keeps the newest committed projection; revisions only grow. */
  #commit(
    projection: ParticipantProjection,
    recorded: readonly string[] = [],
    replace = false,
  ): Projection | undefined {
    if (this.#failure) return undefined;
    const previous = this.#cache.get(projection.threadId);
    if (previous && previous.revision > projection.revision) return previous;
    const ids =
      replace || !previous || previous.recorded.size + recorded.length > RECORDED_LIMIT
        ? new Set<string>()
        : previous.recorded;
    for (const id of recorded) ids.add(id);
    const next: Projection = { ...projection, recorded: ids };
    this.#cache.delete(projection.threadId);
    this.#cache.set(projection.threadId, next);
    while (this.#cache.size > this.#cacheLimit) this.#cache.delete(this.#cache.keys().next().value!);
    return next;
  }

  #notify(threadId: string, revision: number): void {
    for (const method of this.#changed) this.context.notify(method, { threadId, revision });
  }

  #track(done: Promise<unknown>): void {
    this.#tail = done.then(
      () => undefined,
      () => undefined,
    );
  }

  #write(threadId: string, pending: Promise<ParticipantWrite>, forget = false): void {
    this.#track(
      pending.then(
        (write) => {
          this.#commit(write.projection, [], forget);
          if (write.changed && !this.#failure) this.#notify(threadId, write.projection.revision);
        },
        () => this.#cache.delete(threadId),
      ),
    );
  }

  #apply(threadId: string, ids: readonly string[], replace = false): void {
    if (!replace && ids.length === 0) return;
    const known = this.#cache.get(threadId)?.recorded;
    let inflight = this.#inflight.get(threadId);
    const unseen = [...new Set(ids)].filter((id) => replace || (!known?.has(id) && !inflight?.has(id)));
    if (!replace && unseen.length === 0) return;
    if (!inflight) this.#inflight.set(threadId, (inflight = new Map()));
    for (const id of unseen) inflight.set(id, (inflight.get(id) ?? 0) + 1);
    const settle = () => {
      const current = this.#inflight.get(threadId);
      if (!current) return;
      for (const id of unseen) {
        const count = (current.get(id) ?? 1) - 1;
        if (count) current.set(id, count);
        else current.delete(id);
      }
      if (!current.size) this.#inflight.delete(threadId);
    };
    this.#track(
      this.#call("apply", threadId, unseen, replace).then(
        (result) => {
          settle();
          this.#commit(result.projection, result.recorded, replace);
          if (result.changed && !this.#failure) this.#notify(threadId, result.projection.revision);
        },
        () => {
          settle();
          // Uncommitted: drop the projection so the next read and observation retry storage.
          this.#cache.delete(threadId);
        },
      ),
    );
  }
}

/** `createThreadMetadata` factory for a Host identity adapter. The main-thread database handle is not used. */
export function createThreadParticipantsMetadata(options?: ThreadParticipantsMetadataOptions) {
  return (_database: unknown, context: ThreadMetadataContext) => new ThreadParticipantsMetadata(context, options);
}
