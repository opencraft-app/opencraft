// WorkspaceHost store scenarios on Durable Object SQL: every store's published
// migrations run unchanged through the runtime-neutral ledger runner, give the
// same ledger and schema as on node:sqlite, survive a restart without
// reapplying, upgrade from an older build, refuse a tampered checksum, and the
// unchanged domain stores give the same results as on nodeSqlDatabase.
// Interrupted-turn recovery and provider retry are also driven by an
// alarm-backed owner wake-up that survives the instance being evicted.
// Run by tests/storage/workspace-host-workerd.test.ts (Miniflare) and by the
// real Cloudflare rehearsal (scripts/cloudflare/rehearsal.ts).
// See workspace-host-split.md §4.1 and §4.3.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nodeSqlDatabase } from "@opencraft/sqlite-node";
import { migrate, publishedMigrations, scenario, schema, WORKSPACE_HOST_STORES } from "./workspace-host-domain.ts";
import {
  sleep,
  until,
  type WorkerInstance,
  type WorkerRuntime,
  type WorkerScenario,
  type WorkerSpec,
} from "../../cloudflare/worker-runtime.ts";

export const WORKSPACE_HOST_WORKER: WorkerSpec = {
  id: "wshost",
  entry: resolve(import.meta.dirname, "workspace-host-worker.ts"),
  // nodejs_compat supplies node:crypto; node:sqlite, node:fs and node:path load but the Node owners are never called.
  compatibilityFlags: ["nodejs_compat"],
  externalNode: true,
  durableObjects: { STORE: "WorkspaceHostStoreObject" },
};

let sequence = 0;
const instances = new WeakMap<WorkerRuntime, Promise<WorkerInstance>>();
/** Cases without persistence use fresh object names, so they share one instance per runtime. */
const shared = (runtime: WorkerRuntime) => {
  let started = instances.get(runtime);
  if (!started) instances.set(runtime, (started = runtime.start(WORKSPACE_HOST_WORKER)));
  return started;
};
function client(instance: WorkerInstance, object = `workspace-${++sequence}`) {
  return async (method: string, store: string, limit?: number): Promise<any> => {
    const response = await instance.fetch("http://workspace/", {
      method: "POST",
      body: JSON.stringify({ object, method, store, limit }),
    });
    const text = await response.text();
    let outcome: { ok: boolean; value?: unknown; error?: string };
    try {
      outcome = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  };
}
function nodeMemory() {
  const connection = new DatabaseSync(":memory:");
  return { connection, database: nodeSqlDatabase(connection) };
}

export const WORKSPACE_HOST_SCENARIOS: readonly WorkerScenario[] = [
  ...WORKSPACE_HOST_STORES.flatMap((store): WorkerScenario[] => [
    {
      name: `${store}: published migrations run unchanged on Durable Object SQL`,
      async run({ runtime }) {
        const call = client(await shared(runtime));
        const expected = publishedMigrations(store).map(({ version, name, checksum }) => ({ version, name, checksum }));
        assert.deepEqual(await call("migrate", store), expected);
        const node = nodeMemory();
        try {
          migrate(node.database, store);
          assert.deepEqual(await call("schema", store), schema(node.database), "same schema as node:sqlite");
        } finally {
          node.connection.close();
        }
      },
    },
    {
      name: `${store}: domain operations on Durable Object SQL equal nodeSqlDatabase`,
      async run({ runtime }) {
        const call = client(await shared(runtime));
        const node = nodeMemory();
        try {
          migrate(node.database, store);
          assert.deepEqual(await call("scenario", store), await scenario(node.database, store));
        } finally {
          node.connection.close();
        }
      },
    },
  ]),
  {
    name: "restart keeps every recorded ledger row, upgrades an older Host state object through v13–v17 and refuses a tampered checksum",
    async run({ runtime }) {
      const persist = `workspace-host-restart-${++sequence}`;
      const first = await runtime.start(WORKSPACE_HOST_WORKER, { persist });
      const recorded: Record<string, unknown> = {};
      for (const store of WORKSPACE_HOST_STORES) {
        // The Host state object stops at v12 so the restart runs v13–v17 (renames, rebuilt queue, foreign key).
        recorded[store] = await client(first, store)(
          "migrate",
          store,
          store === "opencraft-host-state" ? 12 : undefined,
        );
      }
      await client(first, "tampered")("migrate", "conversation-schedules");
      assert.equal(await client(first, "tampered")("tamperLedger", "conversation-schedules"), 1);
      await runtime.stop(first);

      const second = await runtime.start(WORKSPACE_HOST_WORKER, { persist });
      for (const store of WORKSPACE_HOST_STORES) {
        const call = client(second, store);
        const ledger = await call("migrate", store);
        assert.deepEqual(
          ledger.slice(0, (recorded[store] as unknown[]).length),
          recorded[store],
          `${store}: earlier rows kept`,
        );
        assert.equal(ledger.length, publishedMigrations(store).length);
      }
      await assert.rejects(
        client(second, "tampered")("migrate", "conversation-schedules"),
        /Unsupported database migration history/,
      );
      await runtime.stop(second);
    },
  },
  {
    name: "interrupted-turn recovery: the owner arms the object alarm, which recovers on a fresh instance from durable rows",
    async run({ runtime }) {
      const call = client(await shared(runtime));
      const store = "interrupted-turn-recovery";
      const seeded = await call("seed", store);
      assert.equal(seeded.snapshot.state, "interrupted");
      assert.equal(seeded.alarm, null, "nothing is armed before the engine wakes the owner");
      const woken = await call("engineWake", store);
      assert.equal(typeof woken.alarm, "number", "the engine wake arms the single alarm");
      await call("evict", store).catch(() => undefined);
      const settled = await until(
        runtime,
        () => call("observe", store),
        (value: any) => value.snapshot.state === "running",
        5000,
      );
      assert.equal(settled.snapshot.attempts, 1);
      assert.equal(settled.snapshot.turnId, "auto-1");
      assert.notEqual(settled.instance, woken.instance, "eviction replaced the instance that armed the alarm");
      assert.equal(settled.alarms, 1, "the alarm ran on the instance built after eviction");
      assert.equal(settled.alarm, null, "a continued, live execution leaves no alarm");
    },
  },
  {
    name: "provider retry: the durable retryAt arms the object alarm, which dispatches once on a fresh instance",
    async run({ runtime }) {
      const call = client(await shared(runtime));
      const store = "provider-turn-retry";
      const seeded = await call("seed", store);
      assert.equal(seeded.snapshot.state, "waiting");
      assert.equal(typeof seeded.alarm, "number", "the committed failure arms the alarm");
      await call("evict", store).catch(() => undefined);
      const settled = await until(
        runtime,
        () => call("observe", store),
        (value: any) => value.snapshot.state === "running",
        5000,
      );
      assert.equal(settled.snapshot.attempts, 1);
      assert.equal(settled.snapshot.turnId, "auto-1");
      assert.notEqual(settled.instance, seeded.instance, "eviction replaced the instance that armed the alarm");
      assert.ok(settled.alarms >= 1, "the retry ran from an alarm on the instance built after eviction");
      assert.ok(settled.alarm > seeded.snapshot.retryAt, "the admitted retry re-arms only the reconcile check");
      await sleep(300 * runtime.patience);
      assert.equal((await call("observe", store)).snapshot.attempts, 1, "no late alarm dispatches again");
    },
  },
];
