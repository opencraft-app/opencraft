import assert from "node:assert/strict";
import test from "node:test";

import {
  subscribeHostCatalogReadiness,
  type HostCatalogObservableRuntime,
} from "../../apps/workbench-web/src/runtime/host-catalog-readiness";

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
  detach(hostId: string) {
    this.runtimes.delete(hostId);
    for (const listener of this.listeners) listener();
  }
}

test("Host phase transitions update interaction availability without streaming repaint", () => {
  const registry = new Registry();
  const ready: string[] = [];
  const unsubscribe = subscribeHostCatalogReadiness(registry, ["hermes"], (hostId) => ready.push(hostId));
  const runtime = new Runtime();
  registry.attach("hermes", runtime);
  assert.deepEqual(ready, ["hermes"], "a newly registered runtime updates availability");
  ready.length = 0;

  runtime.setPhase("connecting");
  runtime.setPhase("error");
  assert.deepEqual(ready, ["hermes", "hermes"]);
  runtime.setPhase("reconnecting");
  runtime.setPhase("ready");
  assert.equal(ready.length, 4);
  runtime.setPhase("ready");
  assert.equal(ready.length, 4);
  runtime.setPhase("reconnecting");
  assert.equal(ready.length, 5, "loss of readiness immediately disables cached-row interaction");
  runtime.setPhase("reconnecting");
  assert.equal(ready.length, 5, "ordinary updates in the same phase do not repaint the catalog");

  unsubscribe();
  runtime.setPhase("error");
  runtime.setPhase("ready");
  assert.equal(ready.length, 5);
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

test("a replacement that is already ready revalidates a disabled cached catalog", () => {
  const registry = new Registry();
  const previous = new Runtime();
  previous.setPhase("reconnecting");
  registry.attach("pi", previous);
  const changes: string[] = [];
  const unsubscribe = subscribeHostCatalogReadiness(registry, ["pi"], hostId => changes.push(hostId));
  const replacement = new Runtime();
  replacement.setPhase("ready");
  registry.attach("pi", replacement);
  assert.deepEqual(changes, ["pi"], "replacement must wake the catalog without another phase event");
  previous.setPhase("ready");
  replacement.setPhase("ready");
  assert.deepEqual(changes, ["pi"], "detached runtimes and ordinary streaming must remain quiet");
  registry.detach("pi");
  assert.deepEqual(changes, ["pi", "pi"], "removal must revoke cached-row interaction");
  replacement.setPhase("error");
  assert.deepEqual(changes, ["pi", "pi"]);
  unsubscribe();
});
