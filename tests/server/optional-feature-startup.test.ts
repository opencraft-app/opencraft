import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { ExtensionSupervisor } from "@opencraft/extension-runtime";
import { OptionalFeatureStartup, loadOptionalFeatureModule } from "../../apps/workbench-web/src/runtime/optional-feature-startup";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("optional features remain dormant until chat handoff and share one start", async () => {
  const startup = new OptionalFeatureStartup();
  const slow = deferred<void>();
  const events: string[] = [];
  startup.add("voice", async () => { events.push("voice"); await slow.promise; });
  startup.add("terminal", async () => { events.push("terminal"); });
  assert.deepEqual(events, []);
  const operation = startup.start();
  assert.equal(startup.start(), operation);
  await Promise.resolve();
  assert.deepEqual(events, ["voice"]);
  // A held optional activation cannot hold the already-resolved chat gate.
  assert.equal(await Promise.resolve("chat-ready"), "chat-ready");
  slow.resolve();
  await operation;
  assert.deepEqual(events, ["voice", "terminal"]);
  await startup.dispose();
});

test("a failed optional feature does not prevent the next one", async () => {
  const startup = new OptionalFeatureStartup();
  let terminal = 0;
  startup.add("failed", async () => { throw new Error("unavailable"); });
  startup.add("terminal", async () => { terminal++; });
  await startup.start();
  assert.equal(terminal, 1);
  await startup.dispose();
});

test("retiring before handoff prevents any optional activation", async () => {
  const startup = new OptionalFeatureStartup();
  let count = 0;
  startup.add("voice", async () => { count++; });
  await startup.dispose();
  await startup.start();
  assert.equal(count, 0);
  assert.throws(() => startup.add("late", async () => {}), /abort/i);
});

test("dispose fences a late module before it can install and drains the lane", async () => {
  const startup = new OptionalFeatureStartup();
  const module = deferred<string>();
  let installed = 0;
  startup.add("terminal", async signal => {
    await loadOptionalFeatureModule(() => module.promise, signal);
    installed++;
  });
  startup.add("late-feature", async () => { installed++; });
  const operation = startup.start();
  await Promise.resolve();
  await Promise.resolve();
  await startup.dispose();
  module.resolve("late");
  await operation;
  assert.equal(installed, 0);
});

test("a live activation is drained before its borrowed runtime is retired", async () => {
  const startup = new OptionalFeatureStartup();
  const activation = deferred<void>();
  const events: string[] = [];
  startup.add("voice", async () => { await activation.promise; events.push("activation-settled"); });
  startup.start();
  await Promise.resolve();
  const retiring = startup.dispose().then(() => { events.push("runtime-retired"); });
  await Promise.resolve();
  assert.deepEqual(events, []);
  activation.resolve();
  await retiring;
  assert.deepEqual(events, ["activation-settled", "runtime-retired"]);
});

test("retirement aborts the factory's module scope before a late import resolves", async () => {
  const owner = new AbortController();
  const module = deferred<void>();
  let factories = 0;
  const loading = loadOptionalFeatureModule(async signal => {
    await module.promise;
    signal.throwIfAborted();
    factories++;
    return "definition";
  }, owner.signal);
  await Promise.resolve();
  owner.abort();
  await assert.rejects(loading, /abort/i);
  module.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(factories, 0);
});

test("module deadline aborts its factory scope and rejects late installation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const module = deferred<void>();
  let factories = 0;
  const loading = loadOptionalFeatureModule(async signal => {
    await module.promise;
    signal.throwIfAborted();
    factories++;
    return "definition";
  });
  await Promise.resolve();
  const rejected = assert.rejects(loading, /timed out/);
  t.mock.timers.tick(15_000);
  await rejected;
  module.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(factories, 0);
});

test("real ExtensionSupervisor owns deferred activation and teardown once", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web", context: new Context() });
  const startup = new OptionalFeatureStartup();
  let activations = 0, cleanups = 0;
  startup.add("test.optional", signal => supervisor.loadOptional("test.optional", () => loadOptionalFeatureModule(async () => ({
    manifest: { manifestVersion: 1 as const, id: "test.optional", name: "Optional", version: "0.1.0", apiVersion: 1,
      trust: "trusted" as const, platforms: ["web" as const], activationEvents: ["onStartupFinished" as const] },
    activate() { activations++; return () => { cleanups++; }; },
  }), signal)));
  assert.equal(supervisor.getSnapshot().extensions.length, 0);
  await startup.start();
  assert.equal(activations, 1, JSON.stringify(supervisor.getSnapshot()));
  assert.equal(supervisor.getSnapshot().extensions[0]?.status, "active");
  await startup.dispose();
  await supervisor.dispose();
  assert.equal(cleanups, 1);
});
