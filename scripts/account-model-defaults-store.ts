import { createHash } from "node:crypto";
import { SqliteDocumentStore } from "@opencraft/document-storage/sqlite";
import { parseAccountModelSelection, validateModelDefaultsHost, type AccountModelDefaultsRecord } from "@opencraft/workbench-runtime";

export class AccountModelDefaultsStore {
  private readonly documents: SqliteDocumentStore;
  constructor(path: string) { this.documents = new SqliteDocumentStore(path); }
  get outcome() { return this.documents.outcome; }
  private key(account: string, hostId: string) {
    validateModelDefaultsHost(hostId);
    return `model-defaults:${createHash("sha256").update(JSON.stringify([account, hostId])).digest("hex")}`;
  }
  read(account: string, hostId: string): AccountModelDefaultsRecord {
    const record = this.documents.read(this.key(account, hostId));
    if (record && record.version !== 1) throw new Error("Unsupported model defaults format");
    return { revision: record?.revision ?? 0, selection: record ? parseAccountModelSelection(record.value) : null };
  }
  write(account: string, hostId: string, revision: number, input: unknown) {
    const selection = parseAccountModelSelection(input);
    this.read(account, hostId); // Reject future formats before writing.
    const result = this.documents.compareAndSet(this.key(account, hostId), revision, 1, selection);
    return { updated: result.updated, record: this.read(account, hostId) };
  }
  close() { this.documents.close(); }
}
