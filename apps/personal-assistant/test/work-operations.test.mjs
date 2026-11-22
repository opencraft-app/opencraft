import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { profileFor } from "./helpers.mjs";

test("schema21 upgrade keeps existing Work and adds an empty operation record", (t) => {
  const profile = profileFor(t);
  let store = new Store(profile);
  const workId = store.submit("a", { text: "tidy the release" }).workId;
  const before = store.app.workRecord(workId);
  store.db.exec("DROP TABLE work_operation; PRAGMA user_version=21;");
  store.close();

  store = new Store(profile);
  t.after(() => store.close());
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 22);
  assert.deepEqual(store.app.workRecord(workId), before);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM work_operation").get().n, 0);
  assert.equal(store.db.prepare("pragma quick_check").get().quick_check, "ok");
  assert.deepEqual(store.db.prepare("pragma foreign_key_check").all(), []);

  store.app.executions.recordOperation(store.app.workRecord(workId), "call-1", "environment_run", "npm test");
  assert.deepEqual(
    store.db
      .prepare("SELECT call_id,work_id,tool,summary FROM work_operation")
      .all()
      .map((r) => ({ ...r })),
    [{ call_id: "call-1", work_id: workId, tool: "environment_run", summary: "npm test" }],
  );
});

test("a schema newer than this runner is refused, not opened", (t) => {
  const profile = profileFor(t);
  new Store(profile).close();
  const db = new DatabaseSync(join(profile.path, "assistant.sqlite"));
  db.exec("PRAGMA user_version=23");
  db.close();
  assert.throws(() => new Store(profile), /Unsupported domain schema 23/);
});

test("operations on Work that is no longer current are refused", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const workId = store.submit("a", { text: "first" }).workId;
  const work = store.app.workRecord(workId);
  store.app.works.amend("amend", { workId, expectedRevision: 1, text: "changed" });
  assert.throws(() => store.app.executions.recordOperation(work, "late", "environment_run", "rm -rf build"));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM work_operation").get().n, 0);
});
