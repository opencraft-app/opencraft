import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { MessageSender } from "@opencraft/appserver-protocol";
import type { ThreadMetadataContext, ThreadMetadataExtension } from "@opencraft/appserver-client";
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
}

interface Projection {
  revision: number;
  creator: string | null;
  participants: readonly string[];
  /** Message IDs already committed for this Thread; repeated observations skip storage. */
  readonly recorded: Set<string>;
}
const RECORDED_LIMIT = 4096;

/**
 * Core participants projection over the Host's thread identity tables. A
 * verified sender of an accepted user message is a participant; a sender
 * binding alone is not. Rows stay readable to whoever the Hub admits to the
 * Thread, and the Hub's access session gates every requested Thread ID.
 *
 * This is the single writer of the participant tables. Reads and repeated
 * observations use the committed in-memory projection; storage is touched
 * only for unseen messages, creation, deletion and cold reads.
 */
export class ThreadParticipantsMetadata implements ThreadMetadataExtension {
  readonly methods: readonly string[];
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly #changed: readonly string[];
  readonly #cache = new Map<string, Projection>();
  readonly #cacheLimit: number;
  readonly #statements: {
    participants: StatementSync;
    revision: StatementSync;
    creator: StatementSync;
    bump: StatementSync;
    insertPresence: StatementSync;
    clearPresence: StatementSync;
    insertCreator: StatementSync;
    clearCreator: StatementSync;
    clearSync: StatementSync;
  };
  #closed = false;

  constructor(
    readonly database: DatabaseSync,
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
    // Published table names keep their historical prefix; they are not renamed.
    this.#statements = {
      participants: database.prepare(`SELECT login_name FROM ioa_message_presence
        WHERE thread_id=? GROUP BY login_name ORDER BY MAX(rowid) ASC`),
      revision: database.prepare("SELECT revision FROM ioa_participant_state WHERE thread_id=?"),
      creator: database.prepare("SELECT login_name FROM ioa_thread_creators WHERE thread_id=?"),
      bump: database.prepare(`INSERT INTO ioa_participant_state VALUES(?,1)
        ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1`),
      insertPresence: database.prepare("INSERT OR IGNORE INTO ioa_message_presence VALUES(?,?,?)"),
      clearPresence: database.prepare("DELETE FROM ioa_message_presence WHERE thread_id=?"),
      insertCreator: database.prepare("INSERT OR IGNORE INTO ioa_thread_creators VALUES(?,?)"),
      clearCreator: database.prepare("DELETE FROM ioa_thread_creators WHERE thread_id=?"),
      clearSync: database.prepare("DELETE FROM ioa_presence_sync WHERE thread_id=?"),
    };
  }

  supports(method: string): boolean {
    return this.methods.includes(method);
  }

  snapshot(threadId: string): ThreadParticipants {
    const projection = this.#load(threadId);
    return {
      threadId,
      revision: projection.revision,
      participants: projection.participants,
      creator: projection.creator,
    };
  }

  async request(method: string, params: Value): Promise<unknown> {
    if (!this.supports(method)) throw new Error("Unsupported participant method");
    if (
      !Array.isArray(params.threadIds) ||
      params.threadIds.length > THREAD_PARTICIPANTS_BATCH_LIMIT ||
      params.threadIds.some((id) => typeof id !== "string" || !id || id.length > 4096)
    )
      throw new Error("Invalid participant query");
    if (this.#closed) throw new Error("Participant service closed");
    const ids = [...new Set(params.threadIds as string[])];
    return { data: ids.map((id) => this.snapshot(id)), errors: [] };
  }

  observeResult(method: string, params: Value, result: unknown, sender?: MessageSender | null): void {
    const value = record(result),
      thread = record(value.thread);
    const threadId = string(thread.id) || string(params.threadId);
    if (!threadId || this.#closed) return;
    if ((method === "thread/start" || method === "thread/fork") && sender !== undefined) {
      if (sender && (sender.kind !== "employee" || !isParticipantName(sender.loginName)))
        throw new Error("Invalid creation identity");
      this.#recordCreator(threadId, sender?.loginName ?? null);
    }
    if (method === "thread/delete") {
      this.#forget(threadId);
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
    this.#apply(threadId, [...messageIds(value), ...messageIds(value.turn)]);
  }

  observeNotification(message: Value): void {
    if (this.#closed) return;
    const params = record(message.params),
      threadId = string(params.threadId);
    if (threadId) this.#apply(threadId, [...messageIds(params), ...messageIds(params.turn)]);
  }

  close(): void {
    this.#closed = true;
    this.#cache.clear();
  }

  #load(threadId: string): Projection {
    const cached = this.#cache.get(threadId);
    if (cached) {
      // Map order is recency order for the bounded projection.
      this.#cache.delete(threadId);
      this.#cache.set(threadId, cached);
      return cached;
    }
    const creator = this.#statements.creator.get(threadId)?.login_name;
    const projection: Projection = {
      revision: Number(this.#statements.revision.get(threadId)?.revision ?? 0),
      creator: typeof creator === "string" ? creator : null,
      participants: this.#readParticipants(threadId),
      recorded: new Set(),
    };
    this.#cache.set(threadId, projection);
    while (this.#cache.size > this.#cacheLimit) this.#cache.delete(this.#cache.keys().next().value!);
    return projection;
  }

  #readParticipants(threadId: string): string[] {
    return this.#statements.participants.all(threadId).map((row) => String(row.login_name));
  }

  #transaction<T>(threadId: string, update: () => T): T {
    this.database.exec("SAVEPOINT thread_participants");
    try {
      const value = update();
      this.database.exec("RELEASE thread_participants");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK TO thread_participants; RELEASE thread_participants");
      // The projection may hold uncommitted values; the next read reloads storage.
      this.#cache.delete(threadId);
      throw error;
    }
  }

  #notify(threadId: string, revision: number): void {
    for (const method of this.#changed) this.context.notify(method, { threadId, revision });
  }

  #recordCreator(threadId: string, loginName: string | null): void {
    const projection = this.#load(threadId);
    const inserted = this.#transaction(threadId, () => {
      if (!this.#statements.insertCreator.run(threadId, loginName).changes) return false;
      this.#statements.bump.run(threadId);
      return true;
    });
    if (!inserted) return;
    projection.creator = loginName;
    projection.revision++;
    this.#notify(threadId, projection.revision);
  }

  #forget(threadId: string): void {
    const projection = this.#load(threadId);
    const changed = this.#transaction(threadId, () => {
      this.#statements.clearSync.run(threadId);
      const creator = this.#statements.clearCreator.run(threadId).changes > 0;
      const presence = this.#statements.clearPresence.run(threadId).changes > 0;
      if (creator || presence || projection.participants.length) this.#statements.bump.run(threadId);
      return creator || presence || projection.participants.length > 0;
    });
    projection.recorded.clear();
    if (!changed) return;
    projection.creator = null;
    projection.participants = [];
    projection.revision++;
    this.#notify(threadId, projection.revision);
  }

  #apply(threadId: string, ids: readonly string[], replace = false): void {
    if (this.#closed || (!replace && ids.length === 0)) return;
    const projection = this.#load(threadId);
    const unseen = [...new Set(ids)].filter((id) => replace || !projection.recorded.has(id));
    if (!replace && unseen.length === 0) return;
    const recorded: string[] = [];
    const next = this.#transaction(threadId, () => {
      let inserted = replace && this.#statements.clearPresence.run(threadId).changes > 0;
      for (const id of unseen) {
        if (this.context.isInheritedMessage?.(threadId, id)) continue;
        const sender = this.context.getSender(threadId, id);
        if (sender?.kind !== "employee" || !isParticipantName(sender.loginName)) continue;
        if (this.#statements.insertPresence.run(threadId, id, sender.loginName).changes) inserted = true;
        recorded.push(id);
      }
      if (!inserted) return null;
      const participants = this.#readParticipants(threadId);
      if (
        participants.length === projection.participants.length &&
        participants.every((name, index) => name === projection.participants[index])
      )
        return null;
      this.#statements.bump.run(threadId);
      return participants;
    });
    if (replace) projection.recorded.clear();
    if (projection.recorded.size + recorded.length > RECORDED_LIMIT) projection.recorded.clear();
    for (const id of recorded) projection.recorded.add(id);
    if (!next) return;
    projection.participants = next;
    projection.revision++;
    this.#notify(threadId, projection.revision);
  }
}

/** `createThreadMetadata` factory for a Host identity adapter. */
export function createThreadParticipantsMetadata(options?: ThreadParticipantsMetadataOptions) {
  return (database: DatabaseSync, context: ThreadMetadataContext) =>
    new ThreadParticipantsMetadata(database, context, options);
}
