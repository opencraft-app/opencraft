import { openServerRepository, type ServerDatabaseSource } from "@opencraft/storage-node/server-repository";
import * as Y from "yjs";

const limit = 512 * 1024;
function decode(value: string): Uint8Array {
  if (typeof value !== "string" || value.length > limit * 4 / 3 + 8 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error("Invalid note update");
  return Buffer.from(value, "base64");
}

/** Gateway-owned collaboration data. Never opens engine, identity or browser databases. */
export class ThreadNoteStore {
  private readonly db;
  private readonly closeRepository: () => void;
  readonly outcome;
  constructor(path: ServerDatabaseSource) {
    const opened = openServerRepository(path, "thread-notes");
    this.closeRepository = opened.close;
    this.db = opened.database;
    this.outcome = opened.outcome;
  }
  exchange(serverId: string, threadId: string, update: string, vector: string): { update: string } {
    const incoming = decode(update), stateVector = decode(vector);
    const doc = new Y.Doc();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT state FROM thread_notes WHERE server_id=? AND thread_id=?").get(serverId, threadId);
      if (row) Y.applyUpdate(doc, row.state as Uint8Array);
      const before = Y.encodeStateAsUpdate(doc);
      if (incoming.length) Y.applyUpdate(doc, incoming);
      const state = Y.encodeStateAsUpdate(doc);
      if (state.length > limit || doc.getText("markdown").length > 64 * 1024) throw new Error("Note is too large");
      const result = { update: Buffer.from(Y.encodeStateAsUpdate(doc, stateVector)).toString("base64") };
      if (!Buffer.from(before).equals(state)) this.db.prepare("INSERT INTO thread_notes VALUES(?,?,?,?) ON CONFLICT(server_id,thread_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at").run(serverId, threadId, state, Date.now());
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    } finally { doc.destroy(); }
  }
  close() { this.closeRepository(); }
}
