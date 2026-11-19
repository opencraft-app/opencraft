import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openManagedDatabase } from "@opencraft/sqlite-node";
import { migrations } from "../../scripts/remote-browser/state-migrations.js";
import { BrowserStateStore } from "../../scripts/remote-browser/state-store.mjs";

test("consumer SQLite version 2 upgrades additively with resources, metadata and retirement intact", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "browser-consumer-upgrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite"),
    identity = randomUUID();
  const old = openManagedDatabase({ path, migrations: migrations.slice(0, 2), legacyPolicy: "reject" });
  const key = JSON.stringify(["owner", "browser-" + "1".repeat(64)]),
    _lease = JSON.parse(key)[1];
  const retiredKey = JSON.stringify(["owner", "retired-lease"]);
  const page = {
    key,
    id: createHash("sha256").update(key).digest("hex"),
    ownerId: "owner",
    lifecycle: "open",
    runtime: { kind: "absent" },
    link: null,
  };
  const metadata = { revision: 1, values: { pages: "[]" } };
  const fact = {
    key: retiredKey,
    ownerId: "owner",
    lease: "retired-lease",
    pageIds: ["retired-page"],
    tabIds: ["retired-tab"],
  };
  for (const [key, value] of [
    ["installation", identity],
    ["legacy-digest", "absent"],
    ["import-complete", "1"],
  ])
    old.database.prepare("INSERT INTO browser_meta(key,value) VALUES (?,?)").run(key, value);
  old.database.prepare("INSERT INTO browser_pages(key,value) VALUES (?,?)").run(key, JSON.stringify(page));
  old.database.prepare("INSERT INTO browser_metadata(key,value) VALUES (?,?)").run("owner", JSON.stringify(metadata));
  old.database
    .prepare("INSERT INTO browser_retirements(key,owner,value) VALUES (?,?,?)")
    .run(retiredKey, "owner", JSON.stringify(fact));
  old.database
    .prepare("INSERT INTO browser_retirement_identities(owner,kind,id,key) VALUES (?,?,?,?)")
    .run("owner", "lease", fact.lease, retiredKey);
  old.database.close();
  await writeFile(join(directory, "state.sqlite.identity"), identity, { mode: 0o600 });
  const store = new BrowserStateStore(directory);
  try {
    await store.open();
    assert.equal(store.outcome.status, "migrated");
    assert.equal(store.outcome.appliedVersion, 4);
    assert.deepEqual(store.current.pages, [page]);
    assert.deepEqual(store.account("owner").states, [["owner", metadata]]);
    assert.equal(await store.hasRetirement(retiredKey), true);
    const inspect = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        inspect.prepare("SELECT value FROM browser_retirements WHERE key=?").get(retiredKey)!.value,
        JSON.stringify(fact),
      );
      for (const table of ["browser_presentations", "browser_operations"])
        assert.equal(inspect.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
    } finally {
      inspect.close();
    }
  } finally {
    await store.close();
  }
});
