import { SqlAsyncTransactionError, type SqlDatabase } from "./contract.js";

/**
 * Runtime-neutral conformance cases every SqlDatabase adapter must pass.
 * The caller supplies a fresh, empty, writable database per case and runs
 * the cases with its own test runner (node:test, workerd, ...).
 */
export interface SqlConformanceCase {
  readonly name: string;
  run(database: SqlDatabase): void;
}

class ConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlConformanceFailure";
  }
}

function equal(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual, (_key, value) => (typeof value === "bigint" ? `${value}n` : value));
  const e = JSON.stringify(expected, (_key, value) => (typeof value === "bigint" ? `${value}n` : value));
  if (a !== e) throw new ConformanceFailure(`${what}: expected ${e}, received ${a}`);
}

function throws(action: () => unknown, what: string, check?: (error: unknown) => boolean): unknown {
  try {
    action();
  } catch (error) {
    if (check && !check(error)) throw new ConformanceFailure(`${what}: unexpected error ${String(error)}`);
    return error;
  }
  throw new ConformanceFailure(`${what}: expected an error`);
}

const count = (database: SqlDatabase, table: string) => Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

class Marker extends Error {}

export const SQL_CONFORMANCE_CASES: readonly SqlConformanceCase[] = [
  {
    name: "positional parameters round-trip through get, all and iterate",
    run(db) {
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT) STRICT");
      const insert = db.prepare("INSERT INTO t(id,name,note) VALUES(?,?,?)");
      insert.run(1, "a", null);
      insert.run(2, "b", "x");
      equal(db.prepare("SELECT id,name,note FROM t WHERE id=?").get(1), { id: 1, name: "a", note: null }, "get");
      equal(db.prepare("SELECT id FROM t WHERE id=?").get(99), undefined, "get missing");
      equal(db.prepare("SELECT id,name FROM t ORDER BY id").all(), [{ id: 1, name: "a" }, { id: 2, name: "b" }], "all");
      equal([...db.prepare("SELECT name FROM t WHERE id>? ORDER BY id").iterate(0)], [{ name: "a" }, { name: "b" }], "iterate");
    },
  },
  {
    name: "exec runs multiple statements",
    run(db) {
      db.exec("CREATE TABLE a(x INTEGER) STRICT; CREATE TABLE b(y INTEGER) STRICT; INSERT INTO a VALUES(1);");
      equal(count(db, "a"), 1, "rows in a");
      equal(count(db, "b"), 0, "rows in b");
    },
  },
  {
    name: "changes counts only rows the statement modified",
    run(db) {
      db.exec(
        "CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL) STRICT;" +
          "CREATE INDEX t_v ON t(v);" +
          "CREATE TABLE audit(id INTEGER) STRICT;" +
          "CREATE TRIGGER t_audit AFTER UPDATE ON t BEGIN INSERT INTO audit VALUES(new.id); END;",
      );
      equal(Number(db.prepare("INSERT INTO t(id,v) VALUES(1,0),(2,0)").run().changes), 2, "insert changes");
      equal(Number(db.prepare("UPDATE t SET v=v+1 WHERE id=? AND v=?").run(1, 0).changes), 1, "CAS hit");
      equal(Number(db.prepare("UPDATE t SET v=v+1 WHERE id=? AND v=?").run(1, 0).changes), 0, "CAS miss");
      equal(Number(db.prepare("UPDATE t SET v=9").run().changes), 2, "indexed and triggered update");
      equal(count(db, "audit"), 3, "trigger rows");
      equal(Number(db.prepare("DELETE FROM t WHERE id=?").run(2).changes), 1, "delete changes");
    },
  },
  {
    name: "statements are reusable and remain valid across transactions",
    run(db) {
      db.exec("CREATE TABLE t(v INTEGER) STRICT");
      const insert = db.prepare("INSERT INTO t VALUES(?)");
      const total = db.prepare("SELECT coalesce(sum(v),0) AS s FROM t");
      insert.run(1);
      db.transaction(() => {
        insert.run(2);
        equal(Number(total.get()!.s), 3, "sum inside transaction");
      });
      insert.run(3);
      equal(Number(total.get()!.s), 6, "sum after transaction");
    },
  },
  {
    name: "transaction commits, reports state and returns the action result",
    run(db) {
      db.exec("CREATE TABLE t(v INTEGER) STRICT");
      equal(db.inTransaction, false, "outside");
      const result = db.transaction(() => {
        equal(db.inTransaction, true, "inside");
        db.prepare("INSERT INTO t VALUES(1)").run();
        return "done";
      });
      equal(result, "done", "result");
      equal(db.inTransaction, false, "after");
      equal(count(db, "t"), 1, "committed rows");
    },
  },
  {
    name: "a throwing transaction rolls back and rethrows the same error",
    run(db) {
      db.exec("CREATE TABLE t(v INTEGER) STRICT");
      const marker = new Marker("stop");
      const error = throws(() => db.transaction(() => {
        db.prepare("INSERT INTO t VALUES(1)").run();
        throw marker;
      }), "outer rollback");
      equal(error === marker, true, "same error");
      equal(db.inTransaction, false, "closed");
      equal(count(db, "t"), 0, "rolled back rows");
    },
  },
  {
    name: "a failed nested transaction rolls back only itself",
    run(db) {
      db.exec("CREATE TABLE t(v INTEGER) STRICT");
      db.transaction(() => {
        db.prepare("INSERT INTO t VALUES(1)").run();
        throws(() => db.transaction(() => {
          db.prepare("INSERT INTO t VALUES(2)").run();
          throw new Marker("inner");
        }), "inner rollback", (error) => error instanceof Marker);
        equal(db.inTransaction, true, "outer still open");
        db.transaction(() => db.prepare("INSERT INTO t VALUES(3)").run());
      });
      equal(db.prepare("SELECT v FROM t ORDER BY v").all(), [{ v: 1 }, { v: 3 }], "surviving rows");
    },
  },
  {
    name: "a failed outer transaction discards committed nested work",
    run(db) {
      db.exec("CREATE TABLE t(v INTEGER) STRICT");
      throws(() => db.transaction(() => {
        db.transaction(() => db.prepare("INSERT INTO t VALUES(1)").run());
        throw new Marker("outer");
      }), "outer rollback", (error) => error instanceof Marker);
      equal(count(db, "t"), 0, "rows");
    },
  },
  {
    name: "an asynchronous transaction action is rejected and rolled back",
    run(db) {
      db.exec("CREATE TABLE t(v INTEGER) STRICT");
      throws(() => db.transaction(() => {
        db.prepare("INSERT INTO t VALUES(1)").run();
        return Promise.resolve();
      }), "async action", (error) => error instanceof SqlAsyncTransactionError);
      equal(db.inTransaction, false, "closed");
      equal(count(db, "t"), 0, "rolled back rows");
    },
  },
  {
    name: "BLOB, integer, text and null values round-trip",
    run(db) {
      db.exec("CREATE TABLE t(b BLOB, i INTEGER, s TEXT, n TEXT) STRICT");
      db.prepare("INSERT INTO t VALUES(?,?,?,?)").run(new Uint8Array([0, 1, 254, 255]), 42n, "é", null);
      const row = db.prepare("SELECT b,i,s,n FROM t").get()!;
      equal(row.b instanceof Uint8Array, true, "BLOB type");
      equal([...(row.b as Uint8Array)], [0, 1, 254, 255], "BLOB bytes");
      equal(Number(row.i), 42, "integer");
      equal(row.s, "é", "text");
      equal(row.n, null, "null");
    },
  },
];
