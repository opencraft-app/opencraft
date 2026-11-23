// Storage-port conformance scenarios for the Cloudflare adapters (DO SQL, DO
// state documents, DO secrets/key material, R2 blobs), run by
// tests/storage/storage-ports-workerd.test.ts (Miniflare) and by the real
// Cloudflare rehearsal (scripts/cloudflare/rehearsal.ts). See
// docs/architecture/platform/storage-ports.md.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { SQL_CONFORMANCE_CASES } from "@opencraft/sql/conformance";
import { STATE_DOCUMENT_CONFORMANCE_CASES } from "@opencraft/document-storage/state-conformance";
import { SECRET_CONFORMANCE_CASES } from "@opencraft/secret-storage/conformance";
import { BLOB_CONFORMANCE_CASES } from "@opencraft/blob-storage/conformance";
import type { WorkerInstance, WorkerRuntime, WorkerScenario, WorkerSpec } from "../../cloudflare/worker-runtime.ts";

export const STORAGE_PORTS_WORKER: WorkerSpec = {
  id: "storage",
  entry: resolve(import.meta.dirname, "conformance-worker.ts"),
  durableObjects: { STORAGE: "ConformanceObject" },
  r2Buckets: ["BUCKET"],
};

const URL = "http://conformance/";
const instances = new WeakMap<WorkerRuntime, Promise<WorkerInstance>>();
let sequence = 0;
/** One instance per runtime: every case uses a fresh object and a fresh R2 prefix. */
const instance = (runtime: WorkerRuntime) => {
  let started = instances.get(runtime);
  if (!started) instances.set(runtime, (started = runtime.start(STORAGE_PORTS_WORKER)));
  return started;
};

async function run(runtime: WorkerRuntime, request: { suite: string; index?: number; name?: string }): Promise<unknown> {
  const response = await (await instance(runtime)).fetch(URL, {
    method: "POST",
    body: JSON.stringify({ ...request, prefix: `case-${++sequence}-${Date.now().toString(36)}` }),
  });
  const text = await response.text();
  let outcome: { ok: boolean; result?: unknown; error?: string; stack?: string };
  try { outcome = JSON.parse(text); } catch { assert.fail(`HTTP ${response.status}: ${text.slice(0, 500)}`); }
  if (!outcome.ok) assert.fail(`${outcome.error}\n${outcome.stack ?? ""}`);
  return outcome.result;
}
const probe = (runtime: WorkerRuntime, name: string) => run(runtime, { suite: "probe", name });

const suites = [
  ["Durable Object SQL", "sql", SQL_CONFORMANCE_CASES],
  ["Durable Object state documents", "state", STATE_DOCUMENT_CONFORMANCE_CASES],
  ["Durable Object secrets and key material", "secret", SECRET_CONFORMANCE_CASES],
  ["R2 blobs", "blob", BLOB_CONFORMANCE_CASES],
] as const;

export const STORAGE_PORTS_SCENARIOS: readonly WorkerScenario[] = [
  {
    name: "the bundled suites match the shared conformance modules",
    async run({ runtime }) {
      const manifest = await (await (await instance(runtime)).fetch(URL)).json() as { suites: Record<string, number> };
      assert.deepEqual(manifest.suites, {
        sql: SQL_CONFORMANCE_CASES.length,
        state: STATE_DOCUMENT_CONFORMANCE_CASES.length,
        secret: SECRET_CONFORMANCE_CASES.length,
        blob: BLOB_CONFORMANCE_CASES.length,
      });
    },
  },
  ...suites.flatMap(([label, suite, cases]) =>
    cases.map((conformance, index): WorkerScenario => ({
      name: `${label}: ${conformance.name}`,
      run: ({ runtime }) => run(runtime, { suite, index }).then(() => undefined),
    }))),
  {
    name: "DO SQL: run().changes is SQLite changes(), not rowsWritten",
    async run({ runtime }) {
      const { changes, rowsWritten } = await probe(runtime, "sql: changes() vs rowsWritten") as { changes: number; rowsWritten: number };
      assert.equal(changes, 2);
      assert.ok(rowsWritten > changes, `rowsWritten ${rowsWritten} includes index writes`);
    },
  },
  {
    name: "DO SQL: transaction-control text is refused",
    async run({ runtime }) {
      for (const outcome of await probe(runtime, "sql: transaction-control text is refused by workerd") as { error?: string }[])
        assert.match(outcome.error ?? "", /transactionSync|transaction\(\)/);
    },
  },
  {
    name: "DO SQL: sqlite_master and PRAGMA foreign_keys are readable",
    async run({ runtime }) {
      assert.deepEqual(await probe(runtime, "sql: sqlite_master and PRAGMA reads"), {
        objects: [{ type: "table", name: "a" }, { type: "index", name: "a_x" }],
        foreignKeys: { value: { foreign_keys: 1 } },
      });
    },
  },
  {
    name: "DO SQL: one storage object maps to one port object",
    async run({ runtime }) {
      assert.equal(await probe(runtime, "sql: one storage object maps to one port object"), true);
    },
  },
  {
    name: "DO SQL: integers outside the safe range cannot be bound; reads round (documented gap)",
    async run({ runtime }) {
      const result = await probe(runtime, "sql: integers outside the safe range") as Record<string, { value?: unknown; error?: string }>;
      assert.deepEqual(result.bindSafeBigint, { value: { v: 9007199254740991 } });
      assert.match(result.bindUnsafeBigint!.error ?? "", /RangeError/);
      // workerd converts INTEGER to a JavaScript number without a range check.
      assert.deepEqual(result.readUnsafeLiteral, { value: "9007199254740992" });
    },
  },
  {
    name: "R2 blobs: multipart bodies are verified before completion and keep immutability",
    async run({ runtime }) {
      const result = await probe(runtime, "blob: multipart bodies verify size and digest before they become visible") as Record<string, unknown>;
      assert.deepEqual(result.info, { key: "big", size: 11 * 1024 * 1024 + 3, sha256: (result.info as { sha256: string }).sha256, matches: true });
      assert.equal(result.roundTrip, true);
      assert.deepEqual(result.tail, result.expectedTail);
      assert.equal(result.overwrite, "BlobExistsError");
      assert.equal(result.badDigest, "BlobDigestError");
      assert.equal(result.badDigestVisible, null);
      assert.deepEqual([...(result.racedOutcomes as string[])].sort(), ["BlobExistsError", "stored"]);
    },
  },
  {
    name: "R2 blobs: concurrent single-part puts to one key store exactly one",
    async run({ runtime }) {
      const outcomes = await probe(runtime, "blob: concurrent single-part puts to one key store exactly one") as string[];
      assert.deepEqual([...outcomes].sort(), ["BlobExistsError", "BlobExistsError", "stored"]);
    },
  },
];
