import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { scopedSqlDatabase } from "@opencraft/sql";
import { SQL_CONFORMANCE_CASES } from "@opencraft/sql/conformance";
import { nodeSqlDatabase } from "@opencraft/sqlite-node";

for (const conformance of SQL_CONFORMANCE_CASES) {
  test(`node:sqlite adapter: ${conformance.name}`, () => {
    const connection = new DatabaseSync(":memory:");
    try {
      conformance.run(nodeSqlDatabase(connection));
    } finally {
      connection.close();
    }
  });
}

for (const conformance of SQL_CONFORMANCE_CASES) {
  test(`scoped borrow over node:sqlite: ${conformance.name}`, () => {
    const connection = new DatabaseSync(":memory:");
    try {
      conformance.run(scopedSqlDatabase(nodeSqlDatabase(connection)).database);
    } finally {
      connection.close();
    }
  });
}

test("one connection maps to one port object", () => {
  const connection = new DatabaseSync(":memory:");
  try {
    assert.equal(nodeSqlDatabase(connection), nodeSqlDatabase(connection));
    assert.notEqual(nodeSqlDatabase(connection), nodeSqlDatabase(new DatabaseSync(":memory:")));
  } finally {
    connection.close();
  }
});

test("a closed borrow rejects calls, including earlier statements, without closing the owner", () => {
  const connection = new DatabaseSync(":memory:");
  try {
    const owner = nodeSqlDatabase(connection);
    owner.exec("CREATE TABLE t(v INTEGER) STRICT");
    const lease = scopedSqlDatabase(owner);
    const insert = lease.database.prepare("INSERT INTO t VALUES(?)");
    insert.run(1);
    lease.close();
    assert.throws(() => insert.run(2), /closed/);
    assert.throws(() => lease.database.prepare("SELECT 1"), /closed/);
    assert.throws(() => lease.database.transaction(() => 1), /closed/);
    assert.equal(owner.prepare("SELECT count(*) AS n FROM t").get()!.n, 1);
  } finally {
    connection.close();
  }
});
