import assert from "node:assert/strict";
import test from "node:test";
import { createSandbox, createSandboxPool, DEFAULT_SANDBOX_RESOURCES, SandboxCreationFault, type SandboxBackend, type SandboxCommand, type SandboxEnvironment, type SandboxIdentity, type SandboxPoolPolicy, type SandboxResources } from "../../packages/sandbox/src/index.js";
import { systemdSandboxBackend } from "../../packages/sandbox-node/src/systemd.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const created: SandboxIdentity[] = [], commands: SandboxCommand[] = [], destroyed: string[] = [];
  let creationGate: Promise<void> | undefined, cleanupGate: Promise<void> | undefined, spawnGate: Promise<void> | undefined, creationFailure: "unknown" | "not-created" | undefined;
  let terminations = 0;
  let failCleanup = false, mismatch = false, closed = false;
  const adapter: SandboxBackend = {
    id: "remote-test",
    async initialize() {},
    async create(identity, requested) {
      created.push(identity); await creationGate;
      if (creationFailure) throw new SandboxCreationFault(creationFailure);
      let ended = false;
      const resources = { ...requested, ...(mismatch ? { cpuMillis: 1000 } : {}) };
      const environment: SandboxEnvironment = {
        resources, capabilities: { terminal: false },
        async spawn(command, onOutput) {
          await spawnGate;
          if (ended) throw Error("remote environment destroyed");
          commands.push(command);
          onOutput?.({ stream: "stdout", data: new TextEncoder().encode(command.command.slice(1).join(" ")) });
          return { id: "remote-process:" + commands.length, kind: "process", exited: Promise.resolve({ code: 0 }), async writeStdin() {}, async closeStdin() {}, async terminate() { terminations++; } };
        },
        async close() {
          await cleanupGate;
          if (failCleanup) throw Error("remote deletion unconfirmed");
          if (!ended) { ended = true; destroyed.push(identity.id); }
        },
      };
      return environment;
    },
    async close() { closed = true; },
  };
  return { adapter, created, commands, destroyed, holdCreation(p: Promise<void>) { creationGate = p; }, holdCleanup(p: Promise<void>) { cleanupGate = p; },
    holdSpawn(p: Promise<void>) { spawnGate = p; }, get terminations() { return terminations; },
    rejectCreation(outcome: "unknown" | "not-created") { creationFailure = outcome; }, failCleanup() { failCleanup = true; }, mismatch() { mismatch = true; }, get closed() { return closed; } };
}
const policy: SandboxPoolPolicy = { id: "test", capacity: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 } };
const command: SandboxCommand = { command: ["echo", "$HOME", "a b", "semi;colon"], cwd: "/remote/workspace", env: {} };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("same provider-neutral createSandbox supports remote process handles and multiple commands", async () => {
  const f = fixture(), pool = await createSandboxPool(policy, f.adapter);
  try {
    const sandbox = await createSandbox(pool, { owner: "execution:a" });
    assert.equal(sandbox.identity.backend, "remote-test"); assert.deepEqual(sandbox.resources, DEFAULT_SANDBOX_RESOURCES);
    let output = ""; const child = await sandbox.spawn(command, event => { output += new TextDecoder().decode(event.data); });
    assert.equal(child.id, "remote-process:1"); assert.equal((await child.exited).code, 0); assert.equal(output, "$HOME a b semi;colon");
    await sandbox.spawn({ ...command, command: ["another-command"] }); assert.equal(f.commands.length, 2);
    assert.deepEqual(f.commands[0], command); assert.equal(f.destroyed.length, 0, "command exit does not destroy the environment");
    await sandbox.close(); await assert.rejects(sandbox.spawn(command), /closed/); assert.equal(f.destroyed.length, 1);
  } finally { await pool.close(); }
});

test("admission waits for confirmed whole-environment deletion, not command completion", async () => {
  const f = fixture(), pool = await createSandboxPool(policy, f.adapter), gate = deferred();
  const first = await pool.createSandbox({ owner: "first" }); await (await first.spawn(command)).exited;
  let admitted = false; const next = pool.createSandbox({ owner: "second" }).then(s => { admitted = true; return s; });
  f.holdCleanup(gate.promise); const closing = first.close(); await tick(); assert.equal(admitted, false);
  gate.resolve(); await closing; const second = await next; await second.close(); await pool.close();
});

test("cancelled queued creation never calls the backend and does not block later work", async () => {
  const f = fixture(), pool = await createSandboxPool(policy, f.adapter);
  try {
    const first = await pool.createSandbox({ owner: "first" }), controller = new AbortController();
    const cancelled = pool.createSandbox({ owner: "cancelled", signal: controller.signal }); controller.abort();
    await assert.rejects(cancelled, /cancelled/);
    const next = pool.createSandbox({ owner: "next" }); await first.close(); await (await next).close();
    assert.deepEqual(f.created.map(x => x.owner), ["first", "next"]);
  } finally { await pool.close(); }
});

test("late remote creation after cancellation is reclaimed before returning its budget", async () => {
  const f = fixture(), pool = await createSandboxPool(policy, f.adapter), gate = deferred(), controller = new AbortController();
  f.holdCreation(gate.promise);
  const first = pool.createSandbox({ owner: "cancelled", signal: controller.signal });
  await tick();
  controller.abort(); const rejected = assert.rejects(first, /cancelled/);
  const next = pool.createSandbox({ owner: "next" }); gate.resolve(); await rejected;
  const admitted = await next; assert.equal(f.destroyed.length, 1); await admitted.close(); await pool.close();
});

test("Host close cancels queued and in-flight creation without granting a late environment", async () => {
  const f = fixture(), pool = await createSandboxPool(policy, f.adapter), gate = deferred();
  f.holdCreation(gate.promise);
  const first = pool.createSandbox({ owner: "starting" }), next = pool.createSandbox({ owner: "queued" });
  const rejected = [assert.rejects(first, /cancelled/), assert.rejects(next, /closed/)];
  await tick();
  const closing = pool.close(); gate.resolve(); await closing; await Promise.all(rejected);
  assert.equal(f.created.length, 1); assert.equal(f.destroyed.length, 1); assert.equal(f.closed, true);
});

test("unknown remote create is never replayed or treated as released capacity", async () => {
  const f = fixture(), pool = await createSandboxPool({ ...policy, queueLimit: 0 }, f.adapter);
  f.rejectCreation("unknown");
  await assert.rejects(pool.createSandbox({ owner: "lost-response" }), error => error instanceof SandboxCreationFault && error.identity?.id === f.created[0]!.id);
  await assert.rejects(pool.createSandbox({ owner: "second" }), /queue is full/);
  assert.equal(f.created.length, 1);
  await assert.rejects(pool.close(), /retained/); assert.equal(f.closed, false);
});

test("late process creation cannot escape an environment that is closing", async () => {
  const f = fixture(), pool = await createSandboxPool(policy, f.adapter), gate = deferred();
  const sandbox = await pool.createSandbox({ owner: "late-process" }); f.holdSpawn(gate.promise);
  const pending = sandbox.spawn(command), rejected = assert.rejects(pending, /closed during process creation/);
  const closing = sandbox.close(); await tick(); assert.equal(f.destroyed.length, 0);
  gate.resolve(); await rejected; await closing;
  assert.equal(f.terminations, 1); assert.equal(f.destroyed.length, 1); await pool.close();
});

test("definitive remote creation rejection releases admission without retrying it", async () => {
  const f = fixture(), pool = await createSandboxPool(policy, f.adapter); f.rejectCreation("not-created");
  await assert.rejects(pool.createSandbox({ owner: "first" }), /rejected/);
  await assert.rejects(pool.createSandbox({ owner: "second" }), /rejected/);
  assert.equal(f.created.length, 2); await pool.close();
});

test("failed deletion retains admission and blocks provider teardown", async () => {
  const f = fixture(), pool = await createSandboxPool({ ...policy, queueLimit: 0 }, f.adapter);
  const sandbox = await pool.createSandbox({ owner: "first" }); f.failCleanup();
  await assert.rejects(sandbox.close(), /unconfirmed/);
  await assert.rejects(pool.createSandbox({ owner: "second" }), /queue is full/);
  await assert.rejects(pool.close(), /retained/); assert.equal(f.closed, false);
});

test("effective resource mismatch is rejected and unsupported terminals never execute", async () => {
  const f = fixture(), pool = await createSandboxPool(policy, f.adapter);
  const sandbox = await pool.createSandbox({ owner: "normal" });
  await assert.rejects(sandbox.spawn({ ...command, terminal: { cols: 80, rows: 24 } }), /does not support terminals/);
  assert.equal(f.commands.length, 0); await sandbox.close(); f.mismatch();
  await assert.rejects(pool.createSandbox({ owner: "mismatch" }), /effective resources differ/);
  assert.equal(f.destroyed.length, 2); await pool.close();
});

test("invalid budgets fail before backend creation and there is no bare-spawn fallback", async () => {
  const f = fixture();
  for (const capacity of [{ ...policy.capacity, cpuMillis: 0 }, { ...policy.capacity, memoryBytes: Infinity }]) await assert.rejects(createSandboxPool({ ...policy, capacity }, f.adapter), /budgets/);
  const pool = await createSandboxPool(policy, f.adapter);
  await assert.rejects(pool.createSandbox({ owner: "too-big", resources: { memoryBytes: 9 * 1024 ** 3 } }), /exceeds/);
  await assert.rejects(pool.createSandbox({ owner: "" }), /owner/); assert.equal(f.created.length, 0); await pool.close();
  const unsupported = await createSandboxPool(policy, systemdSandboxBackend({ scope: "system", uid: 0, gid: 0 }));
  await assert.rejects(unsupported.createSandbox({ owner: "a" }), /could not initialize/); await unsupported.close();
});

test("provider preparation is lazy, single-flight and never required to start the Host", async () => {
  let attempts = 0;
  const f = fixture(); f.adapter.initialize = async () => { attempts++; throw Error("private provider diagnostic"); };
  const pool = await createSandboxPool(policy, f.adapter); assert.equal(attempts, 0);
  for (const owner of ["first", "second"]) await assert.rejects(pool.createSandbox({ owner }), /provider could not initialize/);
  assert.equal(attempts, 1); assert.equal(f.created.length, 0); await pool.close();
});
