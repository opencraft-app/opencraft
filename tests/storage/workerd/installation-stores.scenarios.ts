// InstallationCore store scenarios on Durable Object SQL (gateway-split.md §4.2
// storage row): the admission projection, the Server space ledger and the
// orchestration runtime domain give, operation for operation, the same
// normalized results on Durable Object SQL as on nodeSqlDatabase, and the
// SHA-256, base64 and UTF-8 helpers agree with each other in both runtimes.
// Run by tests/storage/installation-stores-workerd.test.ts.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nodeSqlDatabase } from "@opencraft/sqlite-node";
import { installationScenario, migrateInstallation, primitives } from "./installation-stores-domain.ts";
import type { WorkerInstance, WorkerScenario, WorkerSpec } from "../../cloudflare/worker-runtime.ts";

export const INSTALLATION_STORES_WORKER: WorkerSpec = {
  id: "icstores",
  entry: resolve(import.meta.dirname, "installation-stores-worker.ts"),
  // Only the migration runner (the owner's SHA-256) needs nodejs_compat.
  compatibilityFlags: ["nodejs_compat"],
  externalNode: true,
  durableObjects: { STORES: "InstallationStoresObject" },
};

let sequence = 0;
function client(instance: WorkerInstance, object = `installation-stores-${++sequence}`) {
  return async (method: "scenario" | "primitives"): Promise<any> => {
    const response = await instance.fetch("http://stores/", {
      method: "POST",
      body: JSON.stringify({ object, method }),
    });
    const body = await response.text();
    let outcome: { ok: boolean; value?: unknown; error?: string };
    try {
      outcome = JSON.parse(body);
    } catch {
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  };
}

async function onNode() {
  const connection = new DatabaseSync(":memory:");
  try {
    connection.exec("PRAGMA foreign_keys=ON");
    const handle = migrateInstallation(nodeSqlDatabase(connection));
    return await installationScenario(handle.database, handle);
  } finally {
    connection.close();
  }
}

export const INSTALLATION_STORE_SCENARIOS: readonly WorkerScenario[] = [
  {
    name: "admission projection, Server spaces and orchestration runtime on Durable Object SQL equal nodeSqlDatabase",
    async run({ runtime }) {
      const instance = await runtime.start(INSTALLATION_STORES_WORKER);
      try {
        const node = (await onNode()) as [string, unknown][];
        assert.ok(node.length >= 30, "the scenario exercised every store");
        const failures = node.filter(([, value]) => value === false);
        assert.deepEqual(failures, [], "every boolean probe holds on Node");
        const onObject = (await client(instance)("scenario")) as [string, unknown][];
        // Step by step first, for a readable failure; then the whole sequence.
        for (let index = 0; index < node.length; index++)
          assert.deepEqual(onObject[index], node[index], `step ${node[index]![0]}`);
        assert.deepEqual(onObject, node);
      } finally {
        await runtime.stop(instance);
      }
    },
  },
  {
    name: "SHA-256, base64 and UTF-8 helpers agree in workerd and Node, and the portable digest equals the host's",
    async run({ runtime, diagnostic }) {
      const instance = await runtime.start(INSTALLATION_STORES_WORKER);
      try {
        const node = primitives();
        assert.deepEqual(node.sha256, node.portable, "Node: host and portable SHA-256 agree");
        const text = "opencraft é中😀 \ud800";
        const bytes = Uint8Array.from({ length: 300 }, (_, index) => (index * 37) % 256);
        assert.equal(node.base64, Buffer.from(bytes).toString("base64"));
        assert.equal(node.base64Url, Buffer.from(text).toString("base64url"));
        assert.equal(node.lenient, Buffer.from(Buffer.from("AQ*I=junk", "base64")).toString("base64"));
        assert.equal(node.length, Buffer.byteLength(text));
        const onObject = await client(instance)("primitives");
        diagnostic(`process.getBuiltinModule: Node ${node.hostDigest}, workerd ${onObject.hostDigest}`);
        assert.deepEqual(onObject.portable, node.portable, "workerd: portable SHA-256 equals Node's");
        assert.deepEqual(onObject.sha256, node.sha256, "workerd: selected SHA-256 equals Node's");
        assert.deepEqual({ ...onObject, hostDigest: undefined }, { ...node, hostDigest: undefined });
      } finally {
        await runtime.stop(instance);
      }
    },
  },
];
