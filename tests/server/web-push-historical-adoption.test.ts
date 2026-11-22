import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PushStore } from "@opencraft/web-push-node/store";

const owner = readFileSync(new URL("../../packages/web-push-node/src/store.ts", import.meta.url), "utf8");
const v1 = /const SCHEMA = `\n([\s\S]*?)\n`\.trim\(\);/.exec(owner)![1].trim();
const adoption = JSON.parse(
  readFileSync(
    new URL("../../packages/storage-node/src/stores/web-push-node/adopted-identities.json", import.meta.url),
    "utf8",
  ),
)[0];
const v2 = readFileSync(
  new URL(`../../packages/storage-node/src/stores/web-push-node/migrations/${adoption.tag}.sql`, import.meta.url),
  "utf8",
);
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
for (const count of [1, 2])
  test(`adopted owner preserves downstream v${count} ledger and rows`, () => {
    const dir = mkdtempSync(join(tmpdir(), "push-adoption-")),
      path = join(dir, "push.sqlite");
    try {
      let db = new DatabaseSync(path);
      db.exec(
        "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT",
      );
      const items = [
        { version: 1, name: "web-push-subscriptions-and-outbox", sql: v1 },
        { version: 2, name: "notification-destinations", sql: v2 },
      ];
      assert.equal(digest(v2), adoption.checksum);
      for (const m of items.slice(0, count)) {
        db.exec(m.sql);
        db.prepare("INSERT INTO schema_migrations VALUES(?,?,?,?)").run(
          m.version,
          m.name,
          digest(m.sql),
          m.version * 101,
        );
      }
      db.exec("INSERT INTO push_keys(id, public_key, private_key) VALUES(1,'synthetic-public','synthetic-private')");
      const before = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      db.close();
      const owner = new PushStore(path);
      owner.close();
      db = new DatabaseSync(path);
      assert.deepEqual(
        db.prepare("SELECT * FROM schema_migrations WHERE version<=? ORDER BY version").all(count),
        before,
      );
      assert.equal(db.prepare("SELECT public_key FROM push_keys WHERE id=1").get()!.public_key, "synthetic-public");
      assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migrations").get()!.n, 3);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
