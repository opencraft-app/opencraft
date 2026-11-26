import assert from "node:assert/strict";
import { resolve } from "node:path";
import { testScenariosOnMiniflare } from "../cloudflare/node-test.ts";
import type { WorkerSpec } from "../cloudflare/worker-runtime.ts";

const worker: WorkerSpec = {
  id: "bridge-inbox",
  entry: resolve(import.meta.dirname, "fixtures/bridge-inbox-worker.ts"),
  durableObjects: { INBOX: "TestBridgeInbox" },
  compatibilityFlags: ["nodejs_compat"],
  externalNode: true,
};

testScenariosOnMiniflare("bridge-inbox", [
  {
    name: "the existing gateway inbox commits batches atomically and deduplicates after Workerd eviction",
    async run({ runtime }) {
      const instance = await runtime.start(worker);
      try {
        const event = {
          seq: 1,
          route: JSON.stringify(["server", "public-thread"]),
          generation: "engine-1",
          payload: {
            kind: "canonical",
            event: {
              kind: "turn.started",
              threadId: "native-thread",
              turnId: "turn",
              nativeTurnId: "native-turn",
              atMs: 11,
              seq: 1,
            },
          },
        };
        const next = { ...event, seq: 2, payload: { method: "thread/name/updated" } };
        const apply = (rows: readonly unknown[]) =>
          instance.fetch(`${instance.origin}/apply`, {
            method: "POST",
            body: JSON.stringify(rows),
          });
        const state = async () =>
          (await instance.fetch(`${instance.origin}/state`)).json() as Promise<{
            cursor: number;
            rows: { seq: number; projection: { params: { threadId: string } }[] }[];
          }>;
        assert.deepEqual(await (await apply([event])).json(), { cursor: 1, inserted: [event] });
        assert.equal((await apply([next, { ...next, seq: 4 }])).status, 409);
        assert.equal((await apply([next, { ...event, route: JSON.stringify(["other", "thread"]) }])).status, 409);
        const committed = await state();
        assert.equal(committed.cursor, 1);
        assert.equal(committed.rows.length, 1);
        assert.equal(committed.rows[0]?.projection[0]?.params.threadId, "public-thread");
        await instance.fetch(`${instance.origin}/evict`).catch(() => undefined);
        assert.deepEqual(await state(), committed);
        assert.deepEqual(await (await apply([event, next])).json(), { cursor: 2, inserted: [next] });
        assert.deepEqual(
          (await state()).rows.map(({ seq }) => seq),
          [1, 2],
        );
      } finally {
        await runtime.stop(instance);
      }
    },
  },
  {
    name: "Workspace Bridge upgrades its inbox and commits oversized events within the Workerd row budget",
    async run({ runtime }) {
      const instance = await runtime.start(worker);
      try {
        const request = async (action: string) => {
          const response = await instance.fetch(`${instance.origin}/workspace/${action}`);
          assert.equal(response.status, 200, await response.clone().text());
          return response.json();
        };
        assert.equal(await request("v3"), 1);
        assert.equal(await request("apply"), 2);
        await instance.fetch(`${instance.origin}/workspace/evict`).catch(() => undefined);
        assert.deepEqual(await request("state"), {
          cursor: 2, entries: [1], matches: true,
          identities: [{ seq: 2, item: { nativeId: "native-item", id: "public-item" } }],
        });
        assert.deepEqual(await request("restore"), { cursor: 1, archived: 19, live: 0 });
      } finally {
        await runtime.stop(instance);
      }
    },
  },
  {
    name: "Workspace Bridge restores only the selected pending approval's chunks",
    async run({ runtime }) {
      const instance = await runtime.start(worker);
      try {
        const response = await instance.fetch(`${instance.origin}/workspace/select-approvals`);
        assert.equal(response.status, 200, await response.clone().text());
        const result = await response.json() as { removed: number };
        assert.ok(result.removed > 1, "the settled approval did occupy multiple chunks");
        assert.deepEqual(result, {
          removed: result.removed,
          history: [{ seq: 1, turn: { nativeId: "native", id: "public" } }],
          selected: [3],
          next: [4],
          pendingMatches: true,
          laterMatches: true,
          cursor: 4,
        });
      } finally {
        await runtime.stop(instance);
      }
    },
  },
]);
