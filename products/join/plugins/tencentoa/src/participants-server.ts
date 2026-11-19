import type { DatabaseSync } from "node:sqlite";
import type { MessageSender } from "@opencraft/appserver-protocol";
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
  #closed = false;
  constructor(readonly database: DatabaseSync, readonly context: ThreadMetadataContext) {}
  supports(method: string): boolean { return method === TENCENTOA_PARTICIPANTS_METHOD; }
  // Catalog discovery never schedules native history work.
  observeCatalog(_threadIds: readonly string[]): void {}
  snapshot(threadId: string): TencentOaThreadParticipants {
    const participants = this.database.prepare(`SELECT login_name FROM ioa_message_presence
      WHERE thread_id=? GROUP BY login_name ORDER BY MAX(rowid) ASC`).all(threadId).map(row => String(row.login_name));
    const row = this.database.prepare("SELECT revision FROM ioa_participant_state WHERE thread_id=?").get(threadId);
    const creator = this.database.prepare("SELECT login_name FROM ioa_thread_creators WHERE thread_id=?").get(threadId);
    return { threadId, revision: Number(row?.revision ?? 0), participants, creator: typeof creator?.login_name === "string" ? creator.login_name : null };
  }
  async request(_method: string, params: Value): Promise<unknown> {
    if (!Array.isArray(params.threadIds) || params.threadIds.length > 100
      || params.threadIds.some(id => typeof id !== "string" || !id || id.length > 4096)) throw new Error("Invalid participant query");
    const ids = [...new Set(params.threadIds as string[])];
    if (this.#closed) throw new Error("Participant service closed");
    return { data: ids.map(id => this.snapshot(id)), errors: [] };
  }

  observeResult(method: string, params: Value, result: unknown, sender?: MessageSender | null): void {
    const value = record(result), thread = record(value.thread);
    const threadId = string(thread.id) || string(params.threadId);
    if (!threadId || this.#closed) return;
    if ((method === "thread/start" || method === "thread/fork") && sender !== undefined) {
      if (sender && (sender.kind !== "employee" || !/^[A-Za-z0-9._-]{1,128}$/u.test(sender.loginName))) throw new Error("Invalid creation identity");
      const inserted = this.database.prepare("INSERT OR IGNORE INTO ioa_thread_creators VALUES(?,?)").run(threadId, sender?.loginName ?? null);
      if (inserted.changes) {
        this.database.prepare(`INSERT INTO ioa_participant_state VALUES(?,1) ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1`).run(threadId);
        this.context.notify(TENCENTOA_PARTICIPANTS_CHANGED, { threadId, revision: this.snapshot(threadId).revision });
      }
    }
    if (method === "thread/delete") {
      this.database.prepare("DELETE FROM ioa_presence_sync WHERE thread_id=?").run(threadId);
      this.database.prepare("DELETE FROM ioa_thread_creators WHERE thread_id=?").run(threadId);
      this.#apply(threadId, [], true); return;
    }
    if (method === "thread/fork") {
      this.#apply(threadId, [], true); return;
    }
    // A successful native admission confirms this input without a history read.
    if ((method === "turn/start" && string(record(value.turn).id))
      || (method === "turn/steer" && (string(value.turnId) || string(record(value.turn).id)))) {
      const id = string(params.clientUserMessageId);
      if (id) this.#apply(threadId, [id]);
    }
    const turns = Array.isArray(thread.turns) ? thread.turns : Array.isArray(value.turns) ? value.turns : [];
    for (const turn of turns) this.#apply(threadId, messageIds(turn));
    this.#apply(threadId, [...messageIds(value), ...messageIds(value.turn)]);
  }
  observeNotification(message: Value): void {
    if (this.#closed) return;
    const params = record(message.params), threadId = string(params.threadId);
    if (threadId) this.#apply(threadId, [...messageIds(params), ...messageIds(params.turn)]);
  }

  #apply(threadId: string, ids: readonly string[], replace = false, notify = true): boolean {
    if (this.#closed || (!replace && ids.length === 0)) return false;
    const before = this.snapshot(threadId);
    let changed = false;
    this.database.exec("SAVEPOINT ioa_presence");
    try {
      if (replace) this.database.prepare("DELETE FROM ioa_message_presence WHERE thread_id=?").run(threadId);
      const insert = this.database.prepare("INSERT OR IGNORE INTO ioa_message_presence VALUES(?,?,?)");
      for (const id of new Set(ids)) {
        if (this.context.isInheritedMessage?.(threadId, id)) continue;
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
    if (changed && notify) this.context.notify(TENCENTOA_PARTICIPANTS_CHANGED, { threadId, revision: before.revision + 1 });
    return changed;
  }
  close(): void { this.#closed = true; }
}
