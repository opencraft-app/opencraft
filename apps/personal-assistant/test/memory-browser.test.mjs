import { MemoryFileStore } from "../src/adapters/memory/file-store.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { profileFor } from "./helpers.mjs";
import { Runner } from "../src/runner.mjs";
import { createMemoryBrowser } from "../src/runtime/memory-browser.mjs";
async function fixture(t) {
  const profile = profileFor(t, { memoryDefaultScope: "agent" }),
    runner = await Runner.open(profile);
  t.after(() => runner.close());
  let permitted = true,
    count = 0;
  const browse = createMemoryBrowser({
    memory: runner.app.memory,
    history: runner.app.history,
    transact: (f) => runner.uow.transaction(f),
    authorize: async () => {
      count++;
      if (!permitted) throw Error("revoked");
    },
  });
  return {
    profile,
    runner,
    browse,
    revoke() {
      permitted = false;
    },
    count: () => count,
    seed: async (key, value = "记忆 " + key) =>
      runner.dispatch({
        op: "memory.set",
        id: "seed-" + key,
        params: { scope: "agent", key, value },
      }),
  };
}
test("private memory pages are exhaustive, searchable, typed and separate from user scope", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 34; i++) await f.seed("item" + String(i).padStart(2, "0"));
  await f.runner.dispatch({
    op: "memory.set",
    id: "user-seed",
    params: { scope: "user", key: "shared", value: "not private" },
  });
  const a = await f.browse({ action: "list" });
  assert.equal(a.items.length, 30);
  assert.ok(a.next);
  const b = await f.browse({ action: "list", after: a.next });
  assert.equal(b.items.length, 4);
  assert.equal(b.next, null);
  assert.equal(new Set([...a.items, ...b.items].map((m) => m.key)).size, 34);
  assert.ok(a.items.every((m) => m.document.scope === "agent" && m.origin === "explicit"));
  assert.equal((await f.browse({ action: "list", query: "item33" })).items.length, 1);
  assert.equal((await f.browse({ action: "list", kind: "log" })).items.length, 0);
  assert.ok(!JSON.stringify(a).includes("input_id"));
});
test("corrections use existing CAS and tombstones; forgotten retries remain idempotent", async (t) => {
  const f = await fixture(t),
    seed = await f.seed("preference", "旧偏好");
  const p = {
    action: "set",
    key: seed.key,
    expectedRevision: 1,
    value: "新偏好",
    requestId: "correct-0001",
  };
  assert.equal((await f.browse(p)).revision, 2);
  assert.equal((await f.browse(p)).revision, 2);
  assert.equal((await f.browse({ ...p, requestId: "correct-0002" })).code, "conflict");
  assert.equal((await f.browse({ action: "list" })).items[0].value, "新偏好");
  const forget = {
    action: "forget",
    key: seed.key,
    expectedRevision: 2,
    requestId: "forget-00001",
  };
  assert.equal((await f.browse(forget)).revision, 3);
  assert.equal((await f.browse(forget)).revision, 3);
  assert.deepEqual((await f.browse({ action: "list" })).items, []);
  assert.equal((await f.browse({ action: "sources", key: seed.key })).code, "entry_missing");
  assert.ok(f.runner.uow.db.prepare("SELECT count(*) n FROM memory_tombstone").get().n >= 1);
});
test("originals preserve non-fact Markdown and detect changed pages; no path or metadata escape", async (t) => {
  const f = await fixture(t);
  await f.seed("safe");
  const file = f.runner.app.memory.files.locations();
  const first = await f.browse({ action: "file", path: "profile.md" });
  assert.equal(first.exists, true);
  assert.ok(first.content.includes("safe"));
  assert.ok(first.version);
  await f.seed("later");
  assert.equal(
    (
      await f.browse({
        action: "file",
        path: "profile.md",
        offset: 2,
        version: first.version,
      })
    ).code,
    "document_changed",
  );
  for (const path of ["../profile.json", ".dreaming/records.json", "/etc/passwd", "log/../../../a.md"])
    assert.equal((await f.browse({ action: "file", path })).code, "invalid");
  for (const action of [
    { action: "list", scope: "user" },
    {
      action: "set",
      key: "x",
      expectedRevision: 1,
      value: "x".repeat(501),
      requestId: "long-0001",
    },
    { action: "list", limit: 999 },
  ])
    assert.equal((await f.browse(action)).code, "invalid");
  assert.ok(file);
});
test("evidence is restricted to the current assistant user messages; missing provenance is not invented", async (t) => {
  const f = await fixture(t),
    seed = await f.seed("evidence");
  const h = f.runner.app.history;
  h.append(h.main.id, "source", "user", "原始用户证据");
  const message = h.view({}).messages.at(-1);
  f.runner.uow.transaction(() =>
    f.runner.app.r.memories.recordProvenance(seed.key, 1, "automatic", [message.id, "missing"]),
  );
  const rows = await f.browse({ action: "list" });
  assert.deepEqual(rows.items[0].evidenceIds, [message.id, "missing"]);
  const result = await f.browse({ action: "sources", key: seed.key });
  assert.equal(result.sources[0].text, "原始用户证据");
  assert.equal(result.sources[1].unavailable, true);
  const second = await f.seed("explicit");
  assert.deepEqual((await f.browse({ action: "sources", key: second.key })).sources, []);
  f.revoke();
  await assert.rejects(f.browse({ action: "list" }), /revoked/);
});

test("explicit corrections preserve original evidence in exported files, but forgetting removes it", async (t) => {
  const f = await fixture(t),
    seed = await f.seed("source-preserved");
  const h = f.runner.app.history;
  h.append(h.main.id, "basis", "user", "最初的偏好依据");
  const source = h.view({}).messages.at(-1);
  f.runner.uow.transaction(() => f.runner.app.r.memories.recordProvenance(seed.key, 1, "automatic", [source.id]));
  await f.browse({
    action: "set",
    key: seed.key,
    value: "主人纠正后的偏好",
    expectedRevision: 1,
    requestId: "source-correction-01",
  });
  let result = await f.browse({ action: "sources", key: seed.key });
  assert.equal(result.item.origin, "explicit");
  assert.equal(result.sources[0].text, "最初的偏好依据");
  assert.equal(result.item.value, "主人纠正后的偏好");
  await f.browse({
    action: "set",
    key: seed.key,
    value: "再次纠正后的偏好",
    expectedRevision: 2,
    requestId: "source-correction-02",
  });
  result = await f.browse({ action: "sources", key: seed.key });
  assert.equal(result.sources.length, 1);
  // Real file reload, not just the SQL row.
  const records = new MemoryFileStore(f.profile, { readOnly: true }).scan().rows.find((r) => r.key === seed.key);
  assert.deepEqual(records.evidenceIds, [source.id]);
  await f.browse({
    action: "forget",
    key: seed.key,
    expectedRevision: 3,
    requestId: "source-forget-0001",
  });
  assert.equal((await f.browse({ action: "sources", key: seed.key })).code, "entry_missing");
});
test("recent ordering, version-bound pagination, independent prose documents and status changes", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 31; i++) await f.seed("sort" + String(i).padStart(2, "0"));
  let page = await f.browse({ action: "list" });
  assert.ok(page.next);
  const oldest = page.items.at(-1);
  const before = page.version;
  await f.browse({
    action: "set",
    key: oldest.key,
    value: "刚更新的事实",
    expectedRevision: oldest.revision,
    requestId: "sort-update-0001",
  });
  assert.equal((await f.browse({ action: "list", after: page.next })).code, "snapshot_changed");
  assert.notEqual((await f.browse({ action: "status" })).version, before);
  page = await f.browse({ action: "list" });
  assert.equal(page.items[0].key, oldest.key);
  assert.equal(page.total, 31);
  const store = new MemoryFileStore(f.profile, { readOnly: true }),
    dir = store.shard("agent") + "/log";
  fs.mkdirSync(join(store.root, dir), { recursive: true });
  fs.writeFileSync(join(store.root, dir, "2026-01.md"), "# 只有普通段落\n还没有被识别为事实。\n");
  const docs = await f.browse({ action: "documents" });
  assert.equal(docs.action, "documents");
  const doc = docs.items.find((d) => d.path === "log/2026-01.md");
  assert.equal(doc.facts, 0);
  assert.match((await f.browse({ action: "file", path: doc.path })).content, /普通段落/);
  const entry = await f.browse({ action: "entry", key: oldest.key });
  assert.equal(entry.item.revision, 2);
});
