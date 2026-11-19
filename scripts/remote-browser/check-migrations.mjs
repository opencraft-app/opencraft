import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { migrations } from "./state-migrations.ts";
const directory = new URL("../../packages/storage-node/src/stores/remote-browser/", import.meta.url);
const read = (path) => readFileSync(new URL(path, directory));
const json = (path) => JSON.parse(read(path));
const checksum = (value) => createHash("sha256").update(value).digest("hex");
const baseline = json("baseline.json"),
  published = json("published.json"),
  journal = json("migrations/meta/_journal.json");
assert.deepEqual(
  journal.entries.map(({ tag, when }) => ({ tag, when })),
  published.map(({ tag, when }) => ({ tag, when })),
);
for (const entry of published) {
  assert.equal(checksum(read(`migrations/${entry.tag}.sql`)), entry.sqlChecksum);
  assert.equal(checksum(read(`migrations/meta/${entry.tag.slice(0, 4)}_snapshot.json`)), entry.snapshotChecksum);
  if (entry.version > 0) {
    const migration = migrations.find((row) => row.version === entry.version);
    assert.equal(migration?.name, entry.tag);
    assert.equal(checksum(migration.sql), entry.compiledChecksum);
  }
}
assert.deepEqual(
  migrations
    .slice(0, baseline.legacy.length)
    .map(({ version, name, sql }) => ({ version, name, checksum: checksum(sql) })),
  baseline.legacy,
);
assert.equal(migrations.length, baseline.legacy.length + published.filter((entry) => entry.version > 0).length);
assert.equal(published[0].sqlChecksum, baseline.baselineSqlChecksum);
assert.equal(published[0].snapshotChecksum, baseline.baselineSnapshotChecksum);
console.log("Browser migration baseline, SQL, snapshots and compiled tail match their frozen manifests");
