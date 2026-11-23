import {
  isThenable,
  SqlAsyncTransactionError,
  type SqlDatabase,
  type SqlRow,
  type SqlStatement,
  type SqlValue,
} from "@opencraft/sql";
import type { DurableObjectSqlStorage, DurableObjectSqlValue, DurableObjectStorage } from "./bindings.js";

/**
 * Durable Object SQL can only bind numbers, so an integer is accepted only
 * when it is exact as a JavaScript number. Larger integers are rejected rather
 * than silently rounded.
 */
function bind(value: SqlValue): DurableObjectSqlValue | Uint8Array {
  if (typeof value !== "bigint") return value;
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError("Durable Object SQL cannot bind integers outside the safe JavaScript range");
  }
  return Number(value);
}

function row(source: Record<string, DurableObjectSqlValue>): SqlRow {
  const result: SqlRow = {};
  for (const [name, value] of Object.entries(source))
    result[name] = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  return result;
}

function statement(sql: DurableObjectSqlStorage, text: string): SqlStatement {
  const execute = (params: SqlValue[]) => sql.exec(text, ...params.map(bind));
  return {
    get(...params) {
      const next = execute(params).next();
      return next.done ? undefined : row(next.value);
    },
    all(...params) {
      return execute(params).toArray().map(row);
    },
    *iterate(...params) {
      for (const value of execute(params)) yield row(value);
    },
    run(...params) {
      execute(params).toArray();
      // SQLite's changes() counts rows the statement itself modified. The
      // cursor's rowsWritten also counts index and trigger writes.
      return { changes: Number(sql.exec("SELECT changes() AS changes").one().changes) };
    },
  };
}

const adapters = new WeakMap<DurableObjectStorage, SqlDatabase>();

/**
 * The SQL port over a SQLite-backed Durable Object's `ctx.storage`. One
 * storage object maps to one port object. Transactions use `transactionSync`,
 * whose nested calls are savepoints in workerd.
 */
export function durableObjectSqlDatabase(storage: DurableObjectStorage): SqlDatabase {
  const existing = adapters.get(storage);
  if (existing) return existing;
  const sql = storage.sql;
  let depth = 0;
  const database: SqlDatabase = {
    prepare: (text) => statement(sql, text),
    exec(text) {
      sql.exec(text).toArray();
    },
    transaction(action) {
      depth += 1;
      try {
        return storage.transactionSync(() => {
          const result = action();
          if (isThenable(result)) throw new SqlAsyncTransactionError();
          return result;
        });
      } finally {
        depth -= 1;
      }
    },
    get inTransaction() {
      return depth > 0;
    },
  };
  adapters.set(storage, database);
  return database;
}
