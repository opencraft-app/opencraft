import { createHash } from "node:crypto";
import { SqliteDocumentStore } from "@opencraft/document-storage/sqlite";
import { parseThreadReadReceipts } from "@opencraft/workbench-runtime";

/** Installation-owned account data, never a client-selected database or account key. */
export class ThreadReadReceiptStore {
  private readonly documents: SqliteDocumentStore;
  constructor(path: string) { this.documents = new SqliteDocumentStore(path); }
  get outcome() { return this.documents.outcome; }
  private key(account: string) { return `thread-read:${createHash("sha256").update(account).digest("hex")}`; }
  read(account: string): string[] {
    const record = this.documents.read(this.key(account));
    if (record && record.version !== 1) throw new Error("Unsupported read receipt format");
    return record ? parseThreadReadReceipts(record.value) : [];
  }
  merge(account: string, input: unknown): string[] {
    const incoming = parseThreadReadReceipts(input);
    const key = this.key(account);
    for (let attempt = 0; attempt < 8; attempt++) {
      const record = this.documents.read(key);
      if (record && record.version !== 1) throw new Error("Unsupported read receipt format");
      const existing = record ? parseThreadReadReceipts(record.value) : [];
      const receipts = [...new Set([...existing, ...incoming])].slice(-4096);
      if (this.documents.compareAndSet(key, record?.revision ?? 0, 1, receipts).updated) return receipts;
    }
    throw new Error("Read receipt merge conflict");
  }
  close() { this.documents.close(); }
}
