import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ThreadCatalog } from "../apps/local-agent-host/src/thread-catalog.js";

test("OpenCraft owns durable names/archive/provenance and never persists temporary threads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-thread-catalog-"));
  const path = join(directory, "threads.sqlite");
  let catalog = new ThreadCatalog(path);
  try {
    catalog.upsert({ id: "durable", name: "Generated", createdAt: 1, turns: [] });
    catalog.rename("durable", "User name"); catalog.archive("durable", true);
    catalog.upsert({ id: "durable", name: "New generated title", createdAt: 2, turns: [] });
    catalog.upsert({ id: "temporary", name: "Temporary", turns: [] }, { ephemeral: true, forkedFromId: "durable" });
    assert.equal(catalog.list(false).length, 0);
    assert.equal(catalog.list(true)[0]!.name, "User name");
    assert.equal(catalog.get("temporary")!.forkedFromId, "durable");
    catalog.close(); catalog = new ThreadCatalog(path);
    assert.equal(catalog.get("temporary"), null);
    assert.equal(catalog.get("durable")!.name, "User name");
    assert.equal(catalog.get("durable")!.createdAt, 1);
    catalog.archive("durable", false); assert.equal(catalog.list(false).length, 1);
  } finally { catalog.close(); await rm(directory, { recursive: true, force: true }); }
});

import { DatabaseSync } from "node:sqlite";
import { readdir } from "node:fs/promises";

test("ThreadCatalog manages SQLite lifecycle: fresh, up-to-date, adopted, and moved-aside", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-thread-catalog-lifecycle-"));
  const path = join(directory, "threads.sqlite");
  try {
    // 1. Fresh
    const fresh = new ThreadCatalog(path);
    assert.equal(fresh.outcome.status, "fresh");
    fresh.upsert({ id: "t1", name: "Thread 1", createdAt: 1, turns: [] });
    fresh.close();

    // 2. Up-to-date
    const reopened = new ThreadCatalog(path);
    assert.equal(reopened.outcome.status, "up-to-date");
    assert.equal(reopened.get("t1")?.name, "Thread 1");
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ThreadCatalog adopts legacy database with matching schema and moves aside mismatched legacy database", async () => {
  for (const matching of [true, false]) {
    const directory = await mkdtemp(join(tmpdir(), `oc-thread-catalog-legacy-${matching ? "match" : "mismatch"}-`));
    const path = join(directory, "threads.sqlite");
    try {
      const raw = new DatabaseSync(path);
      if (matching) {
        raw.exec("CREATE TABLE opencraft_threads (id TEXT PRIMARY KEY, document TEXT NOT NULL)");
        raw.exec(`INSERT INTO opencraft_threads VALUES('legacy-1', '{"snapshot":{"id":"legacy-1","name":"Legacy","createdAt":100,"turns":[]},"manualTitle":null,"archived":false,"configuration":{}}')`);
      } else {
        raw.exec("CREATE TABLE opencraft_threads (id TEXT PRIMARY KEY, document TEXT NOT NULL, extra_col TEXT)");
        raw.exec("INSERT INTO opencraft_threads VALUES('legacy-1', 'irrelevant', 'extra')");
      }
      raw.close();

      const catalog = new ThreadCatalog(path);
      try {
        assert.equal(catalog.outcome.status, matching ? "adopted" : "moved-aside");
        assert.ok(catalog.outcome.backupPath);
        const files = await readdir(directory);
        assert.ok(files.some(f => f.includes(".pre-v1-")));
        assert.equal(files.some(f => f.includes(".legacy-")), !matching);

        if (matching) {
          assert.equal(catalog.get("legacy-1")?.name, "Legacy");
        } else {
          assert.equal(catalog.get("legacy-1"), null);
          assert.equal(catalog.list(false).length, 0);
        }
      } finally {
        catalog.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("ThreadCatalog document versioning: missing version is 1, version > 1 throws without overwriting, writes version 1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-thread-catalog-versioning-"));
  const path = join(directory, "threads.sqlite");
  try {
    const catalog = new ThreadCatalog(path);
    catalog.upsert({ id: "t1", name: "Versioned", createdAt: 1, turns: [] });
    catalog.close();

    // Verify written document has top-level version: 1
    const raw = new DatabaseSync(path);
    const row = raw.prepare("SELECT document FROM opencraft_threads WHERE id='t1'").get() as { document: string };
    const parsed = JSON.parse(row.document);
    assert.equal(parsed.version, 1);

    // Insert document without version (should be treated as 1)
    raw.exec(`INSERT INTO opencraft_threads VALUES('no-version', '{"snapshot":{"id":"no-version","name":"Old","createdAt":2,"turns":[]},"manualTitle":null,"archived":false,"configuration":{}}')`);

    // Insert document with future version > 1
    raw.exec(`INSERT INTO opencraft_threads VALUES('future-ver', '{"version":2,"snapshot":{"id":"future-ver","name":"Future","createdAt":3,"turns":[]},"manualTitle":null,"archived":false,"configuration":{}}')`);
    raw.close();

    const reopened = new ThreadCatalog(path);
    try {
      // Missing version is read as version 1
      assert.equal(reopened.get("no-version")?.name, "Old");

      // Version > 1 throws on get and list, and cannot be overwritten with default values via upsert
      assert.throws(() => reopened.get("future-ver"), /Unsupported thread document version: 2/);
      assert.throws(() => reopened.list(false), /Unsupported thread document version: 2/);
      assert.throws(() => reopened.upsert({ id: "future-ver", name: "Clobber", turns: [] }), /Unsupported thread document version: 2/);

      // Verify future-ver document is not modified in DB
      const check = new DatabaseSync(path);
      const futureRow = check.prepare("SELECT document FROM opencraft_threads WHERE id='future-ver'").get() as { document: string };
      assert.equal(JSON.parse(futureRow.document).version, 2);
      check.close();
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
