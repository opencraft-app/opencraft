import type { SqlDatabase, SqlStatement } from "./contract.js";

export interface ScopedSqlDatabase {
  readonly database: SqlDatabase;
  /** Revokes this borrower only; the owner's connection stays open. */
  close(): void;
}

/**
 * Lends an owner's connection to a repository. After `close()`, every call
 * through this lease (including statements prepared earlier) fails, while
 * other borrowers and the owner are unaffected.
 */
export function scopedSqlDatabase(owner: SqlDatabase, label = "SQL repository"): ScopedSqlDatabase {
  let closed = false;
  const live = () => {
    if (closed) throw new Error(`${label} is closed`);
  };
  const statement = (inner: SqlStatement): SqlStatement => ({
    get: (...params) => (live(), inner.get(...params)),
    all: (...params) => (live(), inner.all(...params)),
    iterate: (...params) => (live(), inner.iterate(...params)),
    run: (...params) => (live(), inner.run(...params)),
  });
  const database: SqlDatabase = {
    prepare: (sql) => (live(), statement(owner.prepare(sql))),
    exec: (sql) => (live(), owner.exec(sql)),
    transaction: (action) => (live(), owner.transaction(action)),
    get inTransaction() {
      return owner.inTransaction;
    },
  };
  return {
    database,
    close() {
      closed = true;
    },
  };
}
