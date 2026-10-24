import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { ThreadPinWriter } from "../../apps/workbench-web/src/runtime/thread-pin-writer";

const key = { hostId: "host", threadId: "thread" };
const queryKey = ["appserver", "host", "threads", "sidebar"];
const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
function fixture() {
  const query = new QueryClient();
  query.setQueryData(queryKey, { data: [{ id: "thread", pinned: false, name: "original" }] });
  let generation = 1;
  const gates: ReturnType<typeof deferred>[] = [];
  const intents: boolean[] = [];
  const writer = new ThreadPinWriter(query, {
    capture: () => { const owner = generation; return () => owner === generation; },
    persist: async (_key, pinned) => { intents.push(pinned); const gate = deferred(); gates.push(gate); await gate.promise; },
  });
  return { query, writer, gates, intents, revoke: () => { generation++; } };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test("pin membership paints synchronously before native writes and survives stale catalog reads", async () => {
  const f = fixture();
  const operation = f.writer.set(key, true);
  assert.equal(f.writer.project(key, { pinned: false }).pinned, true);
  assert.deepEqual(f.intents, []);
  f.query.setQueryData(queryKey, { data: [{ id: "thread", pinned: false, name: "renamed" }] });
  assert.equal(f.writer.project(key, { pinned: false }).pinned, true);
  await tick(); f.gates[0]!.resolve(); await operation;
  assert.deepEqual(f.query.getQueryData(queryKey), { data: [{ id: "thread", pinned: true, name: "renamed" }] });
});

test("rejected pin rolls back and rejects the caller so the shared notice can report failure", async () => {
  const f = fixture();
  const operation = assert.rejects(f.writer.set(key, true), /denied/);
  await tick(); f.gates[0]!.reject(new Error("denied")); await operation;
  assert.equal(f.writer.project(key, { pinned: false }).pinned, false);
  assert.equal(f.writer.project({ hostId: "other", threadId: "thread" }, { pinned: false }).pinned, false);
});

test("a failed latest intent restores the previous successful pin while retaining unrelated metadata", async () => {
  const f = fixture();
  const first = f.writer.set(key, true);
  const second = assert.rejects(f.writer.set(key, false), /denied/);
  assert.equal(f.writer.project(key, { pinned: true }).pinned, false);
  await tick(); f.gates[0]!.resolve(); await first;
  await tick();
  assert.deepEqual(f.intents, [true, false]);
  f.gates[1]!.reject(new Error("denied")); await second;
  assert.deepEqual(f.query.getQueryData(queryKey), { data: [{ id: "thread", pinned: true, name: "original" }] });
});

test("revoked connections drop the overlay and cannot mutate a successor cache", async () => {
  const f = fixture();
  const first = assert.rejects(f.writer.set(key, true), /changed/);
  const queued = assert.rejects(f.writer.set(key, false), /changed/);
  await tick(); f.revoke();
  f.query.setQueryData(queryKey, { data: [{ id: "thread", pinned: false, name: "successor" }] });
  assert.equal(f.writer.project(key, { pinned: false }).pinned, false);
  f.gates[0]!.resolve(); await Promise.all([first, queued]);
  assert.deepEqual(f.intents, [true]);
  assert.deepEqual(f.query.getQueryData(queryKey), { data: [{ id: "thread", pinned: false, name: "successor" }] });
});

test("authoritative refresh wins after acknowledgement and pending overlay persists until it completes", async () => {
  const f = fixture();
  const refresh = deferred();
  f.query.invalidateQueries = async () => { await refresh.promise; f.query.setQueryData(queryKey, { data: [{ id: "thread", pinned: false }] }); };
  const operation = f.writer.set(key, true);
  await tick(); f.gates[0]!.resolve(); await tick();
  assert.equal(f.writer.project(key, { pinned: false }).pinned, true);
  refresh.resolve(); await operation;
  assert.equal(f.writer.project(key, { pinned: false }).pinned, false);
});
