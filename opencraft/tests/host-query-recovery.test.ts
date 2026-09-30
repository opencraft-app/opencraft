import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { bindHostQueryRecovery } from "../apps/workbench-web/src/runtime/host-query-recovery";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class Host {
  phase = "reconnecting";
  connectionGeneration = 1;
  listeners = new Set<() => void>();
  getSnapshot = () => ({ phase: this.phase, connectionGeneration: this.connectionGeneration });
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  set(phase: string, generation = this.connectionGeneration) {
    this.phase = phase; this.connectionGeneration = generation;
    for (const listener of this.listeners) listener();
  }
}

test("a mounted failed permission query recovers on Host readiness without reopening the menu", async () => {
  const host = new Host();
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const key = ["appserver", "a", "permission-profiles", "/workspace"];
  let available = false, calls = 0;
  const observer = new QueryObserver(queries, { queryKey: key, queryFn: async () => {
    calls++; if (!available) throw new Error("weak network"); return ["read-only", "full"];
  } });
  const unsubscribe = observer.subscribe(() => undefined);
  await tick();
  assert.equal(queries.getQueryState(key)?.status, "error");
  const stop = bindHostQueryRecovery(host, "a", queries);
  available = true;
  host.set("ready", 2);
  await tick(); await tick();
  assert.deepEqual(queries.getQueryData(key), ["read-only", "full"]);
  assert.equal(queries.getQueryState(key)?.error, null);
  assert.equal(calls, 2);
  host.set("ready", 2);
  await tick();
  assert.equal(calls, 2);
  stop(); unsubscribe(); queries.clear();
});

test("old reads cannot overwrite recovered data; other Hosts and inactive caches are preserved", async () => {
  const host = new Host(); host.set("ready");
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const stop = bindHostQueryRecovery(host, "a", queries);
  await tick();
  const key = ["appserver", "a", "composer-capabilities"];
  const other = ["appserver", "b", "permission-profiles"];
  queries.setQueryData(other, ["other"]);
  let release!: (value: string[]) => void;
  const old = queries.fetchQuery({ queryKey: key, queryFn: () => new Promise<string[]>(resolve => { release = resolve; }) }).catch(() => undefined);
  host.set("reconnecting");
  host.set("ready", 2);
  await tick();
  await queries.fetchQuery({ queryKey: key, queryFn: async () => ["new"] });
  release(["old"]); await old; await tick();
  assert.deepEqual(queries.getQueryData(key), ["new"]);
  assert.deepEqual(queries.getQueryData(other), ["other"]);
  assert.equal(queries.getQueryState(other)?.isInvalidated, false);
  stop(); queries.clear();
});

test("binding after initialization observes current readiness instead of losing the event", async () => {
  const host = new Host(); host.set("ready", 3);
  const queries = new QueryClient();
  const key = ["appserver", "a", "threads"];
  queries.setQueryData(key, ["cached"]);
  const stop = bindHostQueryRecovery(host, "a", queries);
  await tick();
  assert.deepEqual(queries.getQueryData(key), ["cached"]);
  assert.equal(queries.getQueryState(key)?.isInvalidated, true);
  stop(); queries.clear();
});
