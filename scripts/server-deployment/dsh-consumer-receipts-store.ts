import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProcessWriter, openManagedDatabase } from '@opencraft/sqlite-node';

const SCHEMA = `CREATE TABLE dsh_consumer_receipts (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE dsh_consumer_receipt_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`;
type Row = { request: string; state: 'unknown' | 'receipt'; receipt?: string; [key: string]: unknown };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ConsumerReceiptRejection extends Error {}

/** Synchronous owner, constructed exclusively inside the receipt Worker. */
export class DshConsumerReceiptStore {
  private readonly release: () => void;
  private readonly managed!: ReturnType<typeof openManagedDatabase>;
  private count = 0;
  private closed = false;
  constructor(directory: string) {
    this.release = acquireProcessWriter(join(directory, 'consumer-receipts.sqlite.writer'));
    try {
      this.managed = openManagedDatabase({ schemaId: "dsh-consumer-receipts", schemaId: 'dsh-consumer-receipts',
        path: join(directory, 'consumer-receipts.sqlite'), legacyPolicy: 'reject',
        migrations: [{ version: 1, name: 'dsh-consumer-receipts', sql: SCHEMA }] });
      this.managed.database.exec('PRAGMA synchronous=FULL');
      this.importLegacy(join(directory, 'consumer-receipts.json'));
      this.count = Number(this.managed.database.prepare('SELECT count(*) AS count FROM dsh_consumer_receipts').get()!.count);
    } catch (error) { this.managed?.database.close(); this.release(); throw error; }
  }
  private importLegacy(path: string): void {
    let bytes: Buffer | undefined, fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077)
        throw new Error('Private DSH consumer receipts required');
      bytes = readFileSync(fd);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
    const source = bytes ? createHash('sha256').update(bytes).digest('hex') : 'absent';
    const db = this.managed.database;
    const imported = db.prepare("SELECT value FROM dsh_consumer_receipt_metadata WHERE key='legacy-source'").get();
    if (imported) {
      if (imported.value !== source) throw new Error('DSH legacy consumer receipt source changed after import');
      return;
    }
    const legacy = bytes ? JSON.parse(bytes.toString('utf8')) : { schemaVersion: 1, rows: {} };
    if (legacy?.schemaVersion !== 1 || !legacy.rows || typeof legacy.rows !== 'object' || Array.isArray(legacy.rows)
      || Object.values(legacy.rows).some(value => {
        const row = value as Row;
        return !row || typeof row.request !== 'string' || !['unknown', 'receipt'].includes(row.state)
          || row.state === 'receipt' && typeof row.receipt !== 'string';
      })) throw new Error('Invalid DSH consumer receipts');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT 1 FROM dsh_consumer_receipts LIMIT 1').get()) throw new Error('Unmarked DSH consumer receipt import');
      const insert = db.prepare('INSERT INTO dsh_consumer_receipts(id,value) VALUES(?,?)');
      for (const [id, row] of Object.entries(legacy.rows)) insert.run(id, JSON.stringify(row));
      db.prepare("INSERT INTO dsh_consumer_receipt_metadata VALUES('legacy-source',?)").run(source);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    // Keep the legacy source immutable. Restart never replays it over the
    // new authority, and an older writer changing it is a storage conflict.
  }
  get observation() { return { activeCount: this.count, outcome: this.managed.outcome }; }
  begin(id: string, request: string): void {
    this.managed.database.prepare('INSERT INTO dsh_consumer_receipts(id,value) VALUES(?,?)')
      .run(id, JSON.stringify({ request, state: 'unknown' }));
    this.count++;
  }
  finish(id: string, packet: unknown): { id: string; receipt: string } {
    const found = this.managed.database.prepare('SELECT value FROM dsh_consumer_receipts WHERE id=?').get(id);
    if (!found) throw new ConsumerReceiptRejection('DSH consumer custody missing');
    const row = JSON.parse(String(found.value)) as Row;
    const receipt = digest({ id, request: row.request, packet });
    if (row.state === 'receipt') {
      if (row.receipt !== receipt) throw new ConsumerReceiptRejection('DSH consumer result changed');
      return { id, receipt };
    }
    this.managed.database.prepare('UPDATE dsh_consumer_receipts SET value=? WHERE id=?')
      .run(JSON.stringify({ ...row, state: 'receipt', receipt }), id);
    return { id, receipt };
  }
  acknowledge(input: { id: string; receipt: string }): void {
    if (!input || typeof input.id !== 'string' || typeof input.receipt !== 'string') throw new ConsumerReceiptRejection('Invalid consumer receipt');
    const found = this.managed.database.prepare('SELECT value FROM dsh_consumer_receipts WHERE id=?').get(input.id);
    const row = found && JSON.parse(String(found.value)) as Row | undefined;
    if (!row || row.state !== 'receipt' || row.receipt !== input.receipt) throw new ConsumerReceiptRejection('Exact consumer receipt required');
    this.managed.database.prepare('DELETE FROM dsh_consumer_receipts WHERE id=?').run(input.id);
    this.count--;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.managed.database.close(); } finally { this.release(); }
  }
}
