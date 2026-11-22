/**
 * Runtime-neutral relational storage used inside a single data owner.
 * See docs/architecture/platform/storage-ports.md.
 */

/**
 * Values accepted as positional parameters and returned in rows. BLOBs are
 * always Uint8Array. INTEGER values must stay within the safe integer range
 * (±2^53−1): Durable Object SQL cannot bind bigint and rounds larger stored
 * integers on read, so portable code never relies on wider integers.
 */
export type SqlValue = null | number | bigint | string | Uint8Array;

export type SqlRow = Record<string, SqlValue>;

export interface SqlRunResult {
  /** Rows directly inserted, updated or deleted by this statement. Backs CAS decisions. */
  readonly changes: number | bigint;
}

/**
 * A reusable SQL text with positional bindings. It is not a promise of a
 * native prepared statement; an adapter may execute the text on every call.
 */
export interface SqlStatement {
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
  iterate(...params: SqlValue[]): IterableIterator<SqlRow>;
  run(...params: SqlValue[]): SqlRunResult;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  /** Executes SQL without bindings or results. Never transaction-control text. */
  exec(sql: string): void;
  /**
   * The only transaction entry. The outermost call is a write transaction;
   * nested calls are savepoints. The action must be synchronous: a thenable
   * result rolls back and throws.
   */
  transaction<T>(action: () => T): T;
  readonly inTransaction: boolean;
}

export class SqlAsyncTransactionError extends Error {
  constructor() {
    super("SQL transactions must be synchronous");
    this.name = "SqlAsyncTransactionError";
  }
}

export function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
