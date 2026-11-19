import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { profileFor } from "./helpers.mjs";
import { recallMemories } from "../src/adapters/sqlite/memory-read.mjs";

function fixture(t, profile = profileFor(t)) {
  const store = new Store(profile);
  t.after(() => store.close());
  return store;
}
function set(store, key, value, extra = {}) {
  return store.app.memory.change(crypto.randomUUID(), "memory.set", {
    key,
    value,
    kind: "log",
    expectedRevision: 0,
    ...extra,
  });
}
const search = (store, text, view = null, limit = 12) => recallMemories(store.db, view, { text, limit });

test("BM25 prioritizes a rare topic over frequent generic matches without mutating the store", (t) => {
  const s = fixture(t);
  set(s, "rare", "Enjoys oboe lessons.");
  set(s, "generic", "Enjoys music music music music.");
  for (let i = 0; i < 18; i++) set(s, "filler-" + i, `Music listening session ${i}.`);
  const before = s.db.prepare("SELECT total_changes() AS n").get().n;
  const result = search(s, "music oboe", null, 1);
  assert.equal(result[0].key, "rare");
  assert.ok(result[0].relevance < 0);
  assert.equal(s.db.prepare("SELECT total_changes() AS n").get().n, before);
});

test("BM25 uses matching Chinese and English segmentation, literal token boundaries and safe FTS syntax", (t) => {
  const s = fixture(t);
  set(s, "zh", "我喜欢周末去唱片店探索爵士音乐。");
  set(s, "en", "Enjoys photography with a camera.");
  assert.ok(search(s, "唱片店").some((m) => m.key === "zh"));
  assert.ok(search(s, "PHOTOGRAPHY").some((m) => m.key === "en"));
  assert.deepEqual(search(s, "photo"), []);
  assert.deepEqual(search(s, 'absenttoken " OR * NOT ()'), []);
});

test("BM25 tracks corrections and forgetting, rolls back changes, and rebuilds on reopen", (t) => {
  const profile = profileFor(t);
  let s = new Store(profile);
  t.after(() => s.close());
  set(s, "fact", "Enjoys astronomy telescopes.");
  assert.equal(search(s, "telescopes").length, 1);
  assert.throws(
    () =>
      s.tx(() => {
        set(s, "temporary", "Enjoys microscopy.");
        throw new Error("abort transaction");
      }),
    /abort transaction/,
  );
  assert.deepEqual(search(s, "microscopy"), []);
  s.app.memory.change("correct", "memory.set", {
    key: "fact",
    value: "Enjoys microscopy.",
    kind: "log",
    expectedRevision: 1,
  });
  assert.deepEqual(search(s, "telescopes"), []);
  assert.equal(search(s, "microscopy").length, 1);
  s.close();
  s = new Store(profile);
  assert.equal(search(s, "microscopy").length, 1);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM main.sqlite_master WHERE name LIKE 'memory_bm25%'").get().n, 0);
  s.app.memory.change("forget", "memory.forget", {
    key: "fact",
    expectedRevision: 2,
  });
  assert.deepEqual(search(s, "microscopy"), []);
  s.close();
  s = new Store(profile);
  assert.deepEqual(search(s, "microscopy"), []);
});

test("Markdown edits refresh BM25 and an index rebuild never overwrites the source file", (t) => {
  const s = fixture(t);
  set(s, "fact", "Enjoys pottery.");
  // Fixture dates can change. Resolve the actual source document from the index.
  const rel = s.db.prepare("SELECT path FROM memory_shard WHERE key=?").get("fact").path;
  const path = join(s.app.memory.files.locations().root, rel);
  const raw = readFileSync(path, "utf8").replace("Enjoys pottery.", "Enjoys birdwatching.");
  writeFileSync(path, raw);
  s.app.memory.list();
  assert.deepEqual(search(s, "pottery"), []);
  assert.equal(search(s, "birdwatching").length, 1);
  s.db.prepare("UPDATE memory SET value=? WHERE key=?").run("stale pottery cache", "fact");
  s.app.memory.list();
  assert.equal(search(s, "birdwatching").length, 1);
  assert.equal(readFileSync(path, "utf8"), raw);
});

test("BM25 filters project grants before applying topK and revocation refreshes the index", (t) => {
  const s = fixture(t);
  for (const slug of ["allowed", "restricted"])
    s.app.memoryProjects.change("create-" + slug, "create", {
      slug,
      name: slug,
    });
  set(s, "fact", "Enjoys ukulele.", { scope: "project", project: "allowed" });
  for (let i = 0; i < 15; i++)
    set(s, "hidden-" + i, "Ukulele ukulele ukulele ukulele.", {
      scope: "project",
      project: "restricted",
    });
  const result = search(s, "ukulele", { projectIds: ["allowed"] }, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].projectId, "allowed");
  assert.deepEqual(search(s, "ukulele", { projectIds: [] }, 1), []);
  s.app.reception.accept("captured", { text: "ukulele" });
  const turn = s.app.reception.turn("captured");
  const session = s.app.receptionQueries.open(turn);
  s.app.memoryProjects.change("leave", "leave", { slug: "allowed" });
  const value = s.app.reception.context(turn);
  assert.ok(
    ![...value.memoryContext.profile, ...value.memoryContext.recent, ...value.memoryRecall].some(
      (m) => m.projectId === "allowed",
    ),
  );
  const resultAfterLeave = session.execute({
    kind: "query",
    name: "memory.search",
    params: { query: "ukulele" },
  });
  assert.ok(!resultAfterLeave.response.data.items.some((m) => m.projectId === "allowed"));
});
