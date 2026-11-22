// Runs the shared storage-port conformance suites against the Cloudflare
// adapters inside workerd (Miniflare, in-memory storage, no network or
// Cloudflare account). See docs/architecture/platform/storage-ports.md.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { SQL_CONFORMANCE_CASES } from "@opencraft/sql/conformance";
import { STATE_DOCUMENT_CONFORMANCE_CASES } from "@opencraft/document-storage/state-conformance";
import { SECRET_CONFORMANCE_CASES } from "@opencraft/secret-storage/conformance";
import { BLOB_CONFORMANCE_CASES } from "@opencraft/blob-storage/conformance";

const COMPATIBILITY_DATE = "2026-07-30";
let miniflare: Miniflare;
let directory: string;
let sequence = 0;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "storage-ports-workerd-"));
  const scriptPath = join(directory, "worker.mjs");
  await build({
    entryPoints: [resolve(import.meta.dirname, "workerd/conformance-worker.ts")],
    outfile: scriptPath,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "import"],
    external: ["cloudflare:*"],
    logLevel: "silent",
  });
  miniflare = new Miniflare({
    // Inline module contents: workerd refuses module paths outside its working directory.
    modules: [{ type: "ESModule", path: "worker.mjs", contents: await readFile(scriptPath, "utf8") }],
    compatibilityDate: COMPATIBILITY_DATE,
    durableObjects: { STORAGE: { className: "ConformanceObject", useSQLite: true } },
    r2Buckets: ["BUCKET"],
  });
  const manifest = await (await miniflare.dispatchFetch("http://conformance/")).json() as { suites: Record<string, number> };
  assert.deepEqual(manifest.suites, {
    sql: SQL_CONFORMANCE_CASES.length,
    state: STATE_DOCUMENT_CONFORMANCE_CASES.length,
    secret: SECRET_CONFORMANCE_CASES.length,
    blob: BLOB_CONFORMANCE_CASES.length,
  }, "the bundled suites match the shared conformance modules");
});
after(async () => {
  await miniflare?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function run(request: { suite: string; index?: number; name?: string }): Promise<unknown> {
  const response = await miniflare.dispatchFetch("http://conformance/", {
    method: "POST",
    body: JSON.stringify({ ...request, prefix: `case-${++sequence}` }),
  });
  const outcome = await response.json() as { ok: boolean; result?: unknown; error?: string; stack?: string };
  if (!outcome.ok) assert.fail(`${outcome.error}\n${outcome.stack ?? ""}`);
  return outcome.result;
}

const suites = [
  ["Durable Object SQL", "sql", SQL_CONFORMANCE_CASES],
  ["Durable Object state documents", "state", STATE_DOCUMENT_CONFORMANCE_CASES],
  ["Durable Object secrets and key material", "secret", SECRET_CONFORMANCE_CASES],
  ["R2 blobs", "blob", BLOB_CONFORMANCE_CASES],
] as const;
for (const [label, suite, cases] of suites)
  cases.forEach((conformance, index) => test(`${label}: ${conformance.name}`, () => run({ suite, index }).then(() => undefined)));

const probe = (name: string) => run({ suite: "probe", name });

test("DO SQL: run().changes is SQLite changes(), not rowsWritten", async () => {
  const { changes, rowsWritten } = await probe("sql: changes() vs rowsWritten") as { changes: number; rowsWritten: number };
  assert.equal(changes, 2);
  assert.ok(rowsWritten > changes, `rowsWritten ${rowsWritten} includes index writes`);
});

test("DO SQL: transaction-control text is refused", async () => {
  for (const outcome of await probe("sql: transaction-control text is refused by workerd") as { error?: string }[])
    assert.match(outcome.error ?? "", /transactionSync|transaction\(\)/);
});

test("DO SQL: sqlite_master and PRAGMA foreign_keys are readable", async () => {
  assert.deepEqual(await probe("sql: sqlite_master and PRAGMA reads"), {
    objects: [{ type: "table", name: "a" }, { type: "index", name: "a_x" }],
    foreignKeys: { value: { foreign_keys: 1 } },
  });
});

test("DO SQL: one storage object maps to one port object", async () => {
  assert.equal(await probe("sql: one storage object maps to one port object"), true);
});

test("DO SQL: integers outside the safe range cannot be bound; reads round (documented gap)", async () => {
  const result = await probe("sql: integers outside the safe range") as Record<string, { value?: unknown; error?: string }>;
  assert.deepEqual(result.bindSafeBigint, { value: { v: 9007199254740991 } });
  assert.match(result.bindUnsafeBigint!.error ?? "", /RangeError/);
  // workerd converts INTEGER to a JavaScript number without a range check.
  assert.deepEqual(result.readUnsafeLiteral, { value: "9007199254740992" });
});

test("R2 blobs: multipart bodies are verified before completion and keep immutability", async () => {
  const result = await probe("blob: multipart bodies verify size and digest before they become visible") as Record<string, unknown>;
  assert.deepEqual(result.info, { key: "big", size: 11 * 1024 * 1024 + 3, sha256: (result.info as { sha256: string }).sha256, matches: true });
  assert.equal(result.roundTrip, true);
  assert.deepEqual(result.tail, result.expectedTail);
  assert.equal(result.overwrite, "BlobExistsError");
  assert.equal(result.badDigest, "BlobDigestError");
  assert.equal(result.badDigestVisible, null);
  assert.deepEqual([...(result.racedOutcomes as string[])].sort(), ["BlobExistsError", "stored"]);
});

test("R2 blobs: concurrent single-part puts to one key store exactly one", async () => {
  const outcomes = await probe("blob: concurrent single-part puts to one key store exactly one") as string[];
  assert.deepEqual([...outcomes].sort(), ["BlobExistsError", "BlobExistsError", "stored"]);
});
