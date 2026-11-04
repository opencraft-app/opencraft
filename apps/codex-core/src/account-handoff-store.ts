import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openManagedDatabase } from "@opencraft/sqlite-node";

export type UnknownRecord = { id: string; route: string; diagnostic?: unknown };
export type HistorySummary = { count: number; sha256: string };
export const ACCOUNT_HANDOFF_MIGRATIONS = [{ version: 1, name: "account-handoff-facts", sql: "CREATE TABLE `account_handoff_checkpoint` (\n\t`singleton` integer PRIMARY KEY NOT NULL,\n\t`value` text NOT NULL,\n\tCONSTRAINT \"account_handoff_singleton\" CHECK(\"account_handoff_checkpoint\".\"singleton\"=1)\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `account_request_facts` (\n\t`seq` integer PRIMARY KEY NOT NULL,\n\t`id` text NOT NULL,\n\t`owner` text NOT NULL,\n\t`route` text NOT NULL,\n\t`terminal` text,\n\t`settled` integer NOT NULL,\n\t`unknown_seq` integer,\n\t`unknown_json` text,\n\tCONSTRAINT \"account_request_terminal\" CHECK(\"account_request_facts\".\"terminal\" IN ('completed','failed')),\n\tCONSTRAINT \"account_request_settled\" CHECK(\"account_request_facts\".\"settled\" IN (0,1))\n) STRICT;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `account_request_facts_id_unique` ON `account_request_facts` (`id`);--> statement-breakpoint\nCREATE UNIQUE INDEX `account_request_facts_unknown_seq_unique` ON `account_request_facts` (`unknown_seq`);" }];

/** Called only under the existing accounts writer lock. No request payloads or credentials. */
export class AccountHandoffStore {
  private readonly db: DatabaseSync;
  private prefix = createHash("sha256").update("[");
  private count = 0;
  constructor(directory: string) {
    const path = join(directory, "account-handoff.sqlite");
    try { const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw Error("Invalid account handoff database permissions");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.db = openManagedDatabase({ schemaId: "account-handoff", path, migrations: ACCOUNT_HANDOFF_MIGRATIONS, legacyPolicy: "reject" }).database;
    this.db.exec("PRAGMA synchronous=FULL");
    for (const row of this.db.prepare("SELECT unknown_json FROM account_request_facts WHERE unknown_json IS NOT NULL ORDER BY unknown_seq").iterate()) this.addDigest(String(row.unknown_json));
  }
  private addDigest(json: string) { if (this.count++) this.prefix.update(","); this.prefix.update(json); }
  transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = action(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  checkpoint<T>(): T | undefined {
    const row = this.db.prepare("SELECT value FROM account_handoff_checkpoint WHERE singleton=1").get();
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  save(value: unknown) { this.db.prepare("INSERT INTO account_handoff_checkpoint VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET value=excluded.value").run(JSON.stringify(value)); }
  import(value: unknown, records: UnknownRecord[]) {
    if (this.checkpoint()) throw Error("Account handoff already imported");
    this.transaction(() => { for (const record of records) this.insertUnknown(record); this.save(value); });
    for (const record of records) this.addDigest(JSON.stringify(record));
  }
  private insertUnknown(record: UnknownRecord) {
    this.db.prepare("INSERT INTO account_request_facts(id,owner,route,settled,unknown_seq,unknown_json) VALUES(?, '', ?,1,(SELECT COALESCE(MAX(unknown_seq),0)+1 FROM account_request_facts),?)").run(record.id, record.route, JSON.stringify(record));
  }
  appendUnknown(record: UnknownRecord) {
    let inserted = false;
    this.transaction(() => {
      const row = this.db.prepare("SELECT terminal,unknown_json FROM account_request_facts WHERE id=?").get(record.id);
      if (row?.terminal) throw Error("Reliable terminal outcome cannot become unknown");
      if (row?.unknown_json) { if (row.unknown_json !== JSON.stringify(record)) throw Error("Conflicting account request fact"); return; }
      if (row) this.db.prepare("UPDATE account_request_facts SET settled=1,unknown_seq=(SELECT COALESCE(MAX(unknown_seq),0)+1 FROM account_request_facts),unknown_json=? WHERE id=?").run(JSON.stringify(record), record.id);
      else this.insertUnknown(record);
      inserted = true;
    });
    if (inserted) this.addDigest(JSON.stringify(record));
  }
  /** Durable may-have-sent boundary. Must finish before invoking upstream fetch. */
  dispatch(id: string, owner: string, route: string) {
    const previous = this.db.prepare("SELECT owner,route,settled FROM account_request_facts WHERE id=?").get(id);
    if (previous) { if (previous.owner !== owner || previous.route !== route || previous.settled) throw Error("Account attempt identity conflict"); return; }
    this.db.prepare("INSERT INTO account_request_facts(id,owner,route,settled) VALUES(?,?,?,0)").run(id, owner, route);
  }
  terminal(id: string, owner: string, result: "completed" | "failed") {
    const row = this.db.prepare("SELECT terminal FROM account_request_facts WHERE id=? AND owner=? AND settled=0").get(id, owner);
    if (!row || row.terminal && row.terminal !== result) throw Error("Account terminal identity conflict");
    this.db.prepare("UPDATE account_request_facts SET terminal=? WHERE id=?").run(result, id);
  }
  settle(id: string, owner: string) {
    const row = this.db.prepare("SELECT terminal,unknown_json FROM account_request_facts WHERE id=? AND owner=?").get(id, owner);
    if (!row) return;
    if (!row.terminal && !row.unknown_json) this.appendUnknown({ id, route: String(this.db.prepare("SELECT route FROM account_request_facts WHERE id=?").get(id)!.route) });
    this.db.prepare("UPDATE account_request_facts SET settled=1 WHERE id=? AND owner=?").run(id, owner);
  }
  recover() {
    for (const row of this.db.prepare("SELECT id,owner FROM account_request_facts WHERE settled=0 ORDER BY unknown_seq").all()) this.settle(String(row.id), String(row.owner));
  }
  records(): UnknownRecord[] { return this.db.prepare("SELECT unknown_json FROM account_request_facts WHERE unknown_json IS NOT NULL ORDER BY unknown_seq").all().map(row => JSON.parse(String(row.unknown_json))); }
  summary(): HistorySummary { return { count: this.count, sha256: this.prefix.copy().update("]").digest("hex") }; }
  page(expected: HistorySummary, after = 0, maxBytes = 32768) {
    const current = this.summary();
    if (!expected || expected.count !== current.count || expected.sha256 !== current.sha256) throw Error("Account history snapshot changed");
    if (!Number.isSafeInteger(after) || after < 0 || after > expected.count || !Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > 32768) throw Error("Invalid account history cursor or budget");
    const result: { snapshot: HistorySummary; records: UnknownRecord[]; next: number | null } = { snapshot: expected, records: [], next: null };
    // The cursor is an ordinal in the immutable unknown sequence, never a SQL offset supplied by a client.
    const rows = this.db.prepare("SELECT unknown_json FROM account_request_facts WHERE unknown_json IS NOT NULL AND unknown_seq > ? ORDER BY unknown_seq LIMIT 256").all(after);
    for (const row of rows) {
      const record = JSON.parse(String(row.unknown_json));
      const next = after + result.records.length + 1;
      if (Buffer.byteLength(JSON.stringify({ ...result, records: [...result.records, record], next })) > maxBytes) break;
      result.records.push(record); result.next = next;
    }
    if (after < expected.count && !result.records.length) throw Error("Account history record exceeds page budget");
    if (after + result.records.length === expected.count) result.next = null;
    return result;
  }
  close() { this.db.close(); }
}
