import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readHistoryResourceMetadata } from "../../apps/opencraft-daemon/src/history-resource-metadata.js";

test("history slow-read resource snapshot keeps only load and PSI averages", async t => {
  const root = await mkdtemp(join(tmpdir(), "oc-history-proc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "pressure"));
  await writeFile(join(root, "loadavg"), "1.25 2.50 3.75 4/99 12345\n");
  await writeFile(join(root, "pressure/cpu"), "some avg10=1.00 avg60=2.00 avg300=3.00 total=900\nfull avg10=4.00 avg60=5.00 avg300=6.00 total=901\n");
  await writeFile(join(root, "pressure/io"), "some avg10=0.10 avg60=0.20 avg300=0.30 total=1\n");
  await writeFile(join(root, "pressure/memory"), "some avg10=7.00 avg60=8.00 avg300=9.00 total=1\n");
  const result = await readHistoryResourceMetadata(root);
  assert.equal(result.status, "captured");
  assert.equal(result.loadAvg1m, 1.25);
  assert.equal(result.cpuPsi.fullAvg300, 6);
  assert.equal(JSON.stringify(result).includes("total=900"), false);
  assert.equal(JSON.stringify(result).includes("12345"), false);
});
