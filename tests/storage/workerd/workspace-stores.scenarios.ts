// WorkspaceHost-side stores on Durable Object SQL (gateway-split.md §4.2,
// storage row): the thread-catalog and employee Git vault chains run unchanged
// through the runtime-neutral ledger runner and give the same ledger and schema
// as their Node owners (`ThreadCatalog`, `EmployeeGitVaultStore`, both through
// openManagedDatabase); the unchanged `SqlThreadDirectory` (with and without
// connection-local execution) and `EmployeeGitVault` give the same results as
// on nodeSqlDatabase; vault rows survive a restart. Run by
// tests/storage/workspace-stores-workerd.test.ts.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nodeSqlDatabase } from "@opencraft/sqlite-node";
import { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import { ThreadCatalog } from "../../../apps/local-agent-host/src/thread-catalog.ts";
import {
  ledger,
  migrate,
  publishedMigrations,
  scenario,
  schema,
  WORKSPACE_SCENARIOS,
  WORKSPACE_STORES,
  type WorkspaceScenario,
  type WorkspaceStore,
} from "./workspace-stores-domain.ts";
import type { WorkerInstance, WorkerRuntime, WorkerScenario, WorkerSpec } from "../../cloudflare/worker-runtime.ts";

export const WORKSPACE_STORES_WORKER: WorkerSpec = {
  id: "wsstores",
  entry: resolve(import.meta.dirname, "workspace-stores-worker.ts"),
  // nodejs_compat supplies node:crypto; node:sqlite loads with the ledger registry but is never called.
  compatibilityFlags: ["nodejs_compat"],
  externalNode: true,
  durableObjects: { STORE: "WorkspaceStoreObject" },
};

/** Opens each store with its Node owner and returns the migrated file (the owner closes first). */
const NODE_OWNERS: Record<WorkspaceStore, (directory: string) => Promise<string>> = {
  "thread-catalog": async (directory) => {
    const path = join(directory, "opencraft-threads.sqlite");
    new ThreadCatalog(path).close();
    return path;
  },
  "employee-git-vault-store": async (directory) => {
    (await EmployeeGitVaultStore.open(directory)).close();
    return join(directory, "employee-git-vault.sqlite");
  },
};

let sequence = 0;
const instances = new WeakMap<WorkerRuntime, Promise<WorkerInstance>>();
const shared = (runtime: WorkerRuntime) => {
  let started = instances.get(runtime);
  if (!started) instances.set(runtime, (started = runtime.start(WORKSPACE_STORES_WORKER)));
  return started;
};
function client(instance: WorkerInstance, object = `workspace-store-${++sequence}`) {
  return async (method: string, target: string): Promise<any> => {
    const response = await instance.fetch("http://workspace-stores/", {
      method: "POST",
      body: JSON.stringify({ object, method, target }),
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

export const WORKSPACE_STORE_SCENARIOS: readonly WorkerScenario[] = [
  ...WORKSPACE_STORES.map((store): WorkerScenario => ({
    name: `${store}: published migrations run unchanged on Durable Object SQL with the Node owner's ledger and schema`,
    async run({ runtime, scratch }) {
      const call = client(await shared(runtime));
      const onObject = await call("migrate", store);
      assert.deepEqual(
        onObject,
        publishedMigrations(store).map(({ version, name, checksum }) => ({ version, name, checksum })),
      );
      const directory = join(scratch, `${store}-${++sequence}`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const connection = new DatabaseSync(await NODE_OWNERS[store](directory), { readOnly: true });
      try {
        const owned = nodeSqlDatabase(connection);
        assert.deepEqual(onObject, ledger(owned), "same ledger as openManagedDatabase");
        assert.deepEqual(await call("schema", store), schema(owned), "same schema as the Node owner");
      } finally {
        connection.close();
      }
    },
  })),
  ...(Object.keys(WORKSPACE_SCENARIOS) as WorkspaceScenario[]).map((name): WorkerScenario => ({
    name: `${name}: runtime-neutral operations on Durable Object SQL equal nodeSqlDatabase`,
    async run({ runtime }) {
      const call = client(await shared(runtime));
      const connection = new DatabaseSync(":memory:");
      try {
        const database = nodeSqlDatabase(connection);
        migrate(database, WORKSPACE_SCENARIOS[name]);
        const onNode = await scenario(database, name);
        assert.ok(JSON.stringify(onNode).length > 400, "the scenario exercised the store");
        assert.deepEqual(await call("scenario", name), onNode);
      } finally {
        connection.close();
      }
    },
  })),
  {
    name: "employee Git vault rows survive a restart of the object",
    async run({ runtime }) {
      const persist = `workspace-stores-restart-${++sequence}`;
      const first = await runtime.start(WORKSPACE_STORES_WORKER, { persist });
      assert.equal(await client(first, "vault")("vaultWrite", "vault"), 1);
      await runtime.stop(first);
      const second = await runtime.start(WORKSPACE_STORES_WORKER, { persist });
      const record = await client(second, "vault")("vaultRead", "vault");
      assert.equal(record.revision, 1);
      assert.equal(record.credential.token, "kept");
      await runtime.stop(second);
    },
  },
];
