// Plugin and extension store scenarios on Durable Object SQL (storage-ports.md
// §3.7): each owner's published migrations run unchanged through the
// runtime-neutral ledger runner and give the same ledger and schema as the Node
// owner's file, the runtime-neutral stores give step-for-step the same results
// as on nodeSqlDatabase, and written rows survive a runtime restart. Run by
// tests/storage/extension-stores-workerd.test.ts.
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nodeSqlDatabase } from "@opencraft/sqlite-node";
import { LoginAdmissionStore } from "../../../plugins/login-admission/src/store.ts";
import { TasksSqliteStore } from "../../../plugins/tasks/src/node-store.ts";
import { SqliteDocumentStore } from "../../../packages/document-storage/src/node-store.ts";
import { ThreadIdentityDatabase } from "../../../apps/opencraft-daemon/src/thread-identity-database.ts";
import {
  EXTENSION_STORES,
  ledger,
  migrate,
  publishedMigrations,
  scenario,
  schema,
  type ExtensionStore,
} from "./extension-stores-domain.ts";
import type { WorkerInstance, WorkerRuntime, WorkerScenario, WorkerSpec } from "../../cloudflare/worker-runtime.ts";

export const EXTENSION_STORES_WORKER: WorkerSpec = {
  id: "extstores",
  entry: resolve(import.meta.dirname, "extension-stores-worker.ts"),
  // nodejs_compat supplies node:crypto; node:sqlite loads with the ledger registry but is never called.
  compatibilityFlags: ["nodejs_compat"],
  externalNode: true,
  durableObjects: { STORE: "ExtensionStoreObject" },
};

/** Opens each store through its Node owner at a new file under `scratch`, closes it and returns the file. */
const NODE_OWNERS: Record<ExtensionStore, (scratch: string, name: string) => string> = {
  "login-admission": (scratch, name) => {
    const path = join(scratch, `${name}.sqlite`);
    new LoginAdmissionStore(path).close();
    return path;
  },
  "thread-participants": (scratch, name) => {
    const owner = new ThreadIdentityDatabase(join(scratch, name));
    owner.close();
    return owner.path;
  },
  tasks: (scratch, name) => {
    const path = join(scratch, `${name}.sqlite`);
    new TasksSqliteStore(path).close();
    return path;
  },
  "document-storage": (scratch, name) => {
    const path = join(scratch, `${name}.sqlite`);
    new SqliteDocumentStore(path).close();
    return path;
  },
};

let sequence = 0;
const instances = new WeakMap<WorkerRuntime, Promise<WorkerInstance>>();
const shared = (runtime: WorkerRuntime) => {
  let started = instances.get(runtime);
  if (!started) instances.set(runtime, (started = runtime.start(EXTENSION_STORES_WORKER)));
  return started;
};
function client(instance: WorkerInstance, object = `extension-${++sequence}`) {
  return async (method: string, store: ExtensionStore): Promise<any> => {
    const response = await instance.fetch("http://extension/", {
      method: "POST",
      body: JSON.stringify({ object, method, store }),
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
function nodeMemory() {
  const connection = new DatabaseSync(":memory:");
  return { connection, database: nodeSqlDatabase(connection) };
}

export const EXTENSION_STORE_SCENARIOS: readonly WorkerScenario[] = [
  ...EXTENSION_STORES.flatMap((store): WorkerScenario[] => [
    {
      name: `${store}: published migrations run unchanged on Durable Object SQL with the Node owner's ledger and schema`,
      async run({ runtime, scratch }) {
        const call = client(await shared(runtime));
        const onObject = await call("migrate", store);
        assert.deepEqual(
          onObject,
          publishedMigrations(store).map(({ version, name, checksum }) => ({ version, name, checksum })),
        );
        const connection = new DatabaseSync(NODE_OWNERS[store](scratch, `${store}-${++sequence}`), { readOnly: true });
        try {
          const owned = nodeSqlDatabase(connection);
          assert.deepEqual(onObject, ledger(owned), "same ledger as the Node owner");
          assert.deepEqual(await call("schema", store), schema(owned), "same schema as the Node owner");
        } finally {
          connection.close();
        }
      },
    },
    {
      name: `${store}: runtime-neutral store operations on Durable Object SQL equal nodeSqlDatabase`,
      async run({ runtime }) {
        const call = client(await shared(runtime));
        const node = nodeMemory();
        try {
          assert.equal(Number(node.connection.prepare("PRAGMA foreign_keys").get()?.foreign_keys), 1);
          migrate(node.database, store);
          const onNode = scenario(node.database, store);
          assert.ok(JSON.stringify(onNode).length > 400, "the scenario exercised the store");
          assert.deepEqual(await call("scenario", store), onNode);
        } finally {
          node.connection.close();
        }
      },
    },
  ]),
  {
    name: "rows and ledgers written by each store survive a Durable Object restart",
    async run({ runtime }) {
      const persist = `extension-stores-restart-${++sequence}`;
      const first = await runtime.start(EXTENSION_STORES_WORKER, { persist });
      const written: Record<string, unknown> = {};
      const ledgers: Record<string, unknown> = {};
      for (const store of EXTENSION_STORES) {
        written[store] = await client(first, store)("seed", store);
        ledgers[store] = await client(first, store)("ledger", store);
      }
      const before: Record<string, unknown> = {};
      for (const store of EXTENSION_STORES) before[store] = await client(first, store)("readBack", store);
      await runtime.stop(first);

      const second = await runtime.start(EXTENSION_STORES_WORKER, { persist });
      try {
        for (const store of EXTENSION_STORES) {
          assert.ok(written[store], `${store}: the seed wrote`);
          assert.deepEqual(await client(second, store)("ledger", store), ledgers[store], `${store}: ledger kept`);
          assert.deepEqual(await client(second, store)("readBack", store), before[store], `${store}: rows kept`);
          assert.deepEqual(
            await client(second, store)("migrate", store),
            ledgers[store],
            `${store}: nothing re-applied`,
          );
        }
        assert.equal(before["tasks"], "Kept");
        assert.equal((before["login-admission"] as { revision: number }).revision, 1);
      } finally {
        await runtime.stop(second);
      }
    },
  },
];
