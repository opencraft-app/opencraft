import assert from "node:assert/strict";
import test from "node:test";

import {
  subscribeHostCatalogReadiness,
  type HostCatalogObservableRuntime,
} from "../apps/workbench-web/src/runtime/host-catalog-readiness";

class Runtime implements HostCatalogObservableRuntime {
  private phase = "idle";
  private readonly listeners = new Set<() => void>();

  getSnapshot() { return { phase: this.phase }; }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  setPhase(phase: string) {
    this.phase = phase;
    for (const listener of this.listeners) listener();
  }
}

class Registry {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly listeners = new Set<() => void>();

  peekRuntime(hostId: string) { return this.runtimes.get(hostId) ?? null; }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  attach(hostId: string, runtime: Runtime) {
    this.runtimes.set(hostId, runtime);
    for (const listener of this.listeners) listener();
  }
}

test("Host readiness reloads a failed thread catalog without a message submission", () => {
  const registry = new Registry();
  const ready: string[] = [];
  const unsubscribe = subscribeHostCatalogReadiness(registry, ["hermes"], (hostId) => ready.push(hostId));
  const runtime = new Runtime();
  registry.attach("hermes", runtime);

  runtime.setPhase("connecting");
  runtime.setPhase("error");
  assert.deepEqual(ready, []);
  runtime.setPhase("reconnecting");
  runtime.setPhase("ready");
  assert.deepEqual(ready, ["hermes"]);
  runtime.setPhase("ready");
  assert.deepEqual(ready, ["hermes"]);

  unsubscribe();
  runtime.setPhase("error");
  runtime.setPhase("ready");
  assert.deepEqual(ready, ["hermes"]);
});

test("an already-ready runtime does not spuriously reload its catalog", () => {
  const registry = new Registry();
  const runtime = new Runtime();
  runtime.setPhase("ready");
  registry.attach("hermes", runtime);
  const ready: string[] = [];
  const unsubscribe = subscribeHostCatalogReadiness(registry, ["hermes"], (hostId) => ready.push(hostId));
  assert.deepEqual(ready, []);
  unsubscribe();
});
