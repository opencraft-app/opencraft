// Deployment-level store scenarios on Durable Object SQL (gateway-split.md §5.1
// G3): each store's published migrations run unchanged through the
// runtime-neutral ledger runner and give the same ledger as the Node owner's
// `openManagedDatabase` and the same schema as node:sqlite, the unchanged
// runtime-neutral stores give the same results as on nodeSqlDatabase, an older
// push object upgrades across a restart keeping its rows, and a tampered
// checksum is refused. Run by tests/storage/deployment-stores-workerd.test.ts.
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nodeSqlDatabase } from "@opencraft/sqlite-node";
import { openPushDatabase } from "@opencraft/web-push-node/store";
import { openMcpAppsDatabase } from "@opencraft/mcp-apps/node";
import { openConnectorDatabase } from "../../../packages/connector-host/src/node-store.ts";
import {
  DEPLOYMENT_STORES,
  ledger,
  migrate,
  publishedMigrations,
  scenario,
  schema,
  type DeploymentStore,
} from "./deployment-stores-domain.ts";
import type { WorkerInstance, WorkerRuntime, WorkerScenario, WorkerSpec } from "../../cloudflare/worker-runtime.ts";

export const DEPLOYMENT_STORES_WORKER: WorkerSpec = {
  id: "depstores",
  entry: resolve(import.meta.dirname, "deployment-stores-worker.ts"),
  // nodejs_compat supplies node:crypto; node:sqlite loads with the ledger registry but is never called.
  compatibilityFlags: ["nodejs_compat"],
  externalNode: true,
  durableObjects: { STORE: "DeploymentStoreObject" },
};

const NODE_OPENERS: Record<DeploymentStore, (path: string) => { close(): void }> = {
  "web-push-node": openPushDatabase,
  "mcp-apps": openMcpAppsDatabase,
  "connector-host": openConnectorDatabase,
};

let sequence = 0;
const instances = new WeakMap<WorkerRuntime, Promise<WorkerInstance>>();
const shared = (runtime: WorkerRuntime) => {
  let started = instances.get(runtime);
  if (!started) instances.set(runtime, (started = runtime.start(DEPLOYMENT_STORES_WORKER)));
  return started;
};
function client(instance: WorkerInstance, object = `deployment-${++sequence}`) {
  return async (method: string, store: string, limit?: number, text?: string): Promise<any> => {
    const response = await instance.fetch("http://deployment/", {
      method: "POST",
      body: JSON.stringify({ object, method, store, limit, text }),
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
  connection.exec("PRAGMA foreign_keys=ON");
  return { connection, database: nodeSqlDatabase(connection) };
}

export const DEPLOYMENT_STORE_SCENARIOS: readonly WorkerScenario[] = [
  ...DEPLOYMENT_STORES.flatMap((store): WorkerScenario[] => [
    {
      name: `${store}: published migrations run unchanged on Durable Object SQL with the Node owner's ledger`,
      async run({ runtime, scratch }) {
        const call = client(await shared(runtime));
        const onObject = await call("migrate", store);
        assert.deepEqual(
          onObject,
          publishedMigrations(store).map(({ version, name, checksum }) => ({ version, name, checksum })),
        );
        const owned = NODE_OPENERS[store](join(scratch, `${store}-${++sequence}.sqlite`)) as {
          database: Parameters<typeof ledger>[0];
          close(): void;
        };
        try {
          assert.deepEqual(onObject, ledger(owned.database), "same ledger as openManagedDatabase");
          assert.deepEqual(await call("schema", store), schema(owned.database), "same schema as the Node owner");
        } finally {
          owned.close();
        }
      },
    },
    {
      name: `${store}: runtime-neutral store operations on Durable Object SQL equal nodeSqlDatabase`,
      async run({ runtime }) {
        const call = client(await shared(runtime));
        const node = nodeMemory();
        try {
          migrate(node.database, store);
          const onNode = scenario(node.database, store);
          assert.ok(JSON.stringify(onNode).length > 200, "the scenario exercised the store");
          assert.deepEqual(await call("scenario", store), onNode);
        } finally {
          node.connection.close();
        }
      },
    },
  ]),
  {
    name: "restart keeps recorded ledgers, upgrades an older push object keeping its rows and refuses a tampered checksum",
    async run({ runtime }) {
      const persist = `deployment-stores-restart-${++sequence}`;
      const first = await runtime.start(DEPLOYMENT_STORES_WORKER, { persist });
      const recorded: Record<string, unknown[]> = {};
      for (const store of DEPLOYMENT_STORES)
        recorded[store] = await client(first, store)("migrate", store, store === "web-push-node" ? 1 : undefined);
      assert.equal(recorded["web-push-node"]!.length, 1);
      await client(first, "web-push-node")(
        "sql",
        "web-push-node",
        undefined,
        "INSERT INTO push_devices VALUES('d','human-a','b','{}','null','https://w.example','/','en-US','{}')",
      );
      await client(first, "tampered")("migrate", "mcp-apps");
      assert.equal(await client(first, "tampered")("tamperLedger", "mcp-apps"), 1);
      await runtime.stop(first);

      const second = await runtime.start(DEPLOYMENT_STORES_WORKER, { persist });
      for (const store of DEPLOYMENT_STORES) {
        const ledgerRows = await client(second, store)("migrate", store);
        assert.deepEqual(ledgerRows.slice(0, recorded[store]!.length), recorded[store], `${store}: earlier rows kept`);
        assert.equal(ledgerRows.length, publishedMigrations(store).length);
      }
      assert.deepEqual(
        await client(second, "web-push-node")(
          "sql",
          "web-push-node",
          undefined,
          "SELECT id,actor_id,enabled,target FROM push_devices",
        ),
        [{ id: "d", actor_id: "human-a", enabled: 1, target: null }],
        "the v1 device survives the upgrade with the v2 defaults",
      );
      await assert.rejects(client(second, "tampered")("migrate", "mcp-apps"), /Unsupported database migration history/);
      await runtime.stop(second);
    },
  },
];
