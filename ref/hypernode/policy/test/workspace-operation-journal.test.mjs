import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { WorkspaceOperationJournal } from "../src/services/workspace-operation-journal.ts";

function sqliteStorage() {
  const database = new DatabaseSync(":memory:");
  return {
    available: true,
    database,
    sql: {
      exec(source, ...bindings) {
        const statement = database.prepare(source);
        const rows = statement.columns().length > 0
          ? statement.all(...bindings)
          : (statement.run(...bindings), []);
        return { toArray: () => rows };
      },
    },
  };
}

test("workspace operation journal exposes only non-terminal saga records for recovery", () => {
  const storage = sqliteStorage();
  let sequence = 0;
  const journal = new WorkspaceOperationJournal(storage, {
    createId: () => `operation-${++sequence}`,
    now: () => 1_700_000_000_000 + sequence,
  });
  const first = journal.begin({
    operationKind: "threadFork",
    sourceThreadId: "source",
    targetThreadId: "target-a",
    sourceViewId: "source",
    targetViewId: "target-a",
  });
  const second = journal.begin({
    operationKind: "threadFork",
    sourceThreadId: "source",
    targetThreadId: "target-b",
    sourceViewId: "source",
    targetViewId: "target-b",
  });
  journal.transition(first.operationId, "workspacePrepared");
  journal.transition(second.operationId, "committed");

  assert.deepEqual(journal.pending("threadFork").map((row) => row.operationId), [first.operationId]);
  journal.transition(first.operationId, "rolledBack", { error: "restart recovery" });
  assert.deepEqual(journal.pending("threadFork"), []);
  assert.equal(journal.get(first.operationId).errorMessage, "restart recovery");
  assert.ok(journal.get(first.operationId).terminalAtMs);
});
