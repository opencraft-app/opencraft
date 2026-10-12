import type { DatabaseSync } from "node:sqlite";
import type { ThreadMetadataContext, ThreadMetadataExtension } from "@opencraft/appserver-client";
import { TENCENTOA_PARTICIPANTS_CHANGED, TENCENTOA_PARTICIPANTS_METHOD, type TencentOaThreadParticipants } from "./contract";

type Value = Record<string, unknown>;
const record = (value: unknown): Value => value && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
function messageIds(value: unknown): string[] {
  const source = record(value);
  const ids: string[] = [];
  const visit = (item: unknown) => {
    const value = record(item);
    if (["userMessage", "UserMessage", "steeringUserMessage"].includes(string(value.type))) {
      const id = string(value.clientId) || string(value.client_id) || string(value.clientUserMessageId);
      if (id) ids.push(id);
    }
  };
  visit(source.item);
  if (Array.isArray(source.items)) source.items.forEach(visit);
  return ids;
}

/** Derived IOA index in the existing Host DB. Sender bindings alone are not participation. */
export class TencentOaParticipants implements ThreadMetadataExtension {
  readonly methods = [TENCENTOA_PARTICIPANTS_METHOD];
  readonly capabilities = { [TENCENTOA_PARTICIPANTS_METHOD]: { version: 1 } };
  readonly #initialized = new Set<string>();
  readonly #epochs = new Map<string, number>();
  readonly #jobs = new Map<string, Promise<void>>();
  #closed = false;
  constructor(readonly database: DatabaseSync, readonly context: ThreadMetadataContext) {
    database.exec(`CREATE TABLE IF NOT EXISTS ioa_message_presence (
      thread_id TEXT NOT NULL, client_message_id TEXT NOT NULL, login_name TEXT NOT NULL,
      PRIMARY KEY(thread_id,client_message_id)) STRICT;
      CREATE INDEX IF NOT EXISTS ioa_presence_names ON ioa_message_presence(thread_id,login_name);
      CREATE TABLE IF NOT EXISTS ioa_participant_state (
      thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL) STRICT;`);
  }
  supports(method: string): boolean { return method === TENCENTOA_PARTICIPANTS_METHOD; }
  snapshot(threadId: string): TencentOaThreadParticipants {
    const participants = this.database.prepare(`SELECT DISTINCT login_name FROM ioa_message_presence
      WHERE thread_id=? ORDER BY login_name`).all(threadId).map(row => String(row.login_name));
    const row = this.database.prepare("SELECT revision FROM ioa_participant_state WHERE thread_id=?").get(threadId);
    return { threadId, revision: Number(row?.revision ?? 0), participants };
  }
  async request(_method: string, params: Value): Promise<unknown> {
    if (!Array.isArray(params.threadIds) || params.threadIds.length > 100
      || params.threadIds.some(id => typeof id !== "string" || !id || id.length > 4096)) throw new Error("Invalid participant query");
    const ids = [...new Set(params.threadIds as string[])];
    // Bound the native reconciliation fan-out; the ordinary list needs only the visible rows.
    for (let index = 0; index < ids.length; index += 4) await Promise.all(ids.slice(index, index + 4).map(async id => {
      await this.#jobs.get(id);
      if (!this.#initialized.has(id)) await this.#refresh(id);
    }));
    if (this.#closed) throw new Error("Participant service closed");
    return { data: ids.map(id => this.snapshot(id)) };
  }
  observeResult(method: string, params: Value, result: unknown): void {
    const value = record(result), thread = record(value.thread);
    const threadId = string(thread.id) || string(params.threadId);
    if (!threadId || this.#closed) return;
    if (method === "thread/delete") {
      this.#epochs.set(threadId, (this.#epochs.get(threadId) ?? 0) + 1);
      this.#initialized.delete(threadId); this.#apply(threadId, [], true); return;
    }
    if (method === "thread/rollback" || method === "thread/fork") {
      this.#epochs.set(threadId, (this.#epochs.get(threadId) ?? 0) + 1);
      this.#initialized.delete(threadId); this.#schedule(threadId); return;
    }
    const turns = Array.isArray(thread.turns) ? thread.turns : Array.isArray(value.turns) ? value.turns : [];
    for (const turn of turns) this.#apply(threadId, messageIds(turn));
    this.#apply(threadId, [...messageIds(value), ...messageIds(value.turn)]);
    const turnId = method === "turn/start" ? string(record(value.turn).id)
      : method === "turn/steer" ? string(value.turnId) || string(record(value.turn).id) : "";
    if (turnId) this.#schedule(threadId, turnId);
  }
  observeNotification(message: Value): void {
    const params = record(message.params), threadId = string(params.threadId);
    if (!threadId || this.#closed) return;
    const ids = [...messageIds(params), ...messageIds(params.turn)];
    if (ids.length) {
      this.#epochs.set(threadId, (this.#epochs.get(threadId) ?? 0) + 1);
      this.#apply(threadId, ids);
    }
    if (message.method === "turn/completed") {
      const turnId = string(record(params.turn).id);
      if (turnId) this.#schedule(threadId, turnId);
    }
  }
  #apply(threadId: string, ids: readonly string[], replace = false): void {
    if (this.#closed) return;
    const before = this.snapshot(threadId);
    let changed = false;
    this.database.exec("SAVEPOINT ioa_presence");
    try {
      if (replace) this.database.prepare("DELETE FROM ioa_message_presence WHERE thread_id=?").run(threadId);
      const insert = this.database.prepare("INSERT OR IGNORE INTO ioa_message_presence VALUES(?,?,?)");
      for (const id of new Set(ids)) {
        const sender = this.context.getSender(threadId, id);
        if (sender?.kind === "employee") insert.run(threadId, id, sender.loginName);
      }
      const after = this.snapshot(threadId);
      changed = JSON.stringify(before.participants) !== JSON.stringify(after.participants);
      if (changed) this.database.prepare(`INSERT INTO ioa_participant_state VALUES(?,1)
        ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1`).run(threadId);
      this.database.exec("RELEASE ioa_presence");
    } catch (error) {
      this.database.exec("ROLLBACK TO ioa_presence; RELEASE ioa_presence"); throw error;
    }
    if (changed) this.context.notify(TENCENTOA_PARTICIPANTS_CHANGED, { threadId, revision: before.revision + 1 });
  }
  #schedule(threadId: string, turnId?: string): void {
    // A native rejection never reaches this hook. Unknown delivery is resolved by real history.
    void this.#refresh(threadId, turnId).catch(() => { this.#initialized.delete(threadId); });
  }
  #refresh(threadId: string, turnId?: string): Promise<void> {
    const previous = this.#jobs.get(threadId);
    const job = (previous ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (this.#closed) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        const epoch = this.#epochs.get(threadId) ?? 0;
        // No authenticated sender records means there are no names to recover.
        const ids = this.context.hasSenders(threadId) ? await this.context.readMessageIds(threadId, turnId) : [];
        if (this.#closed) return;
        if (epoch !== (this.#epochs.get(threadId) ?? 0)) continue;
        this.#apply(threadId, ids, !turnId);
        if (!turnId) this.#initialized.add(threadId);
        return;
      }
      throw new Error("Participant history changed during reconciliation");
    });
    this.#jobs.set(threadId, job);
    void job.finally(() => { if (this.#jobs.get(threadId) === job) this.#jobs.delete(threadId); }).catch(() => {});
    return job;
  }
  close(): void { this.#closed = true; this.#initialized.clear(); }
}
