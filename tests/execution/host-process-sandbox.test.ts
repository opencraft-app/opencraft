import assert from "node:assert/strict";
import test from "node:test";
import { HostProcessService } from "../../apps/local-agent-host/src/process-service.js";
import { createSandboxPool, SandboxCreationFault, type SandboxBackend, type SandboxCommand, type SandboxExit, type SandboxPool } from "../../packages/sandbox/src/index.js";

const spawn = { processHandle: "terminal", command: ["/bin/echo", "must-not-run-bare"], cwd: "/tmp", tty: true, size: { cols: 80, rows: 24 } };
test("Host requires a sandbox path instead of defaulting to the local home", async () => {
  let admissions = 0;
  const service = new HostProcessService(undefined, { async createSandbox() { admissions++; throw Error("must not admit"); }, async close() {} });
  try {
    assert.throws(() => service.dispatch("process/spawn", { ...spawn, cwd: undefined }), /requires a working directory/);
    assert.equal(admissions, 0);
  } finally { await service.close(); }
});

test("Host terminal propagates sandbox denial and never starts an uncontained command", async () => {
  const pool: SandboxPool = { async createSandbox() { throw Error("sandbox admission denied"); }, async close() {} };
  const service = new HostProcessService(undefined, pool);
  try {
    await assert.rejects(Promise.resolve(service.dispatch("process/spawn", spawn)), /admission denied/);
    assert.deepEqual(service.dispatch("process/list", {}), { processes: [] });
  } finally { await service.close(); }
});

test("Host preserves a maximum-length process handle as the sandbox execution owner", async () => {
  const owner = "t".repeat(256);
  const pool = await createSandboxPool({ id: "long-owner", capacity: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 } }, {
    id: "remote-test", async initialize() {}, async close() {},
    async create(identity) { assert.equal(identity.owner, owner); throw new SandboxCreationFault("not-created"); },
  });
  const service = new HostProcessService(undefined, pool);
  try {
    await assert.rejects(Promise.resolve(service.dispatch("process/spawn", { ...spawn, processHandle: owner })), /rejected before/);
  } finally { await service.close(); await pool.close(); }
});

test("Host close cancels pending terminal admission without allocating or replaying", async () => {
  let requested = 0;
  const pool: SandboxPool = {
    createSandbox({ signal }) {
      requested++;
      return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(Error("cancelled admission")), { once: true }));
    }, async close() {},
  };
  const service = new HostProcessService(undefined, pool);
  const operation = Promise.resolve(service.dispatch("process/spawn", spawn));
  const rejected = assert.rejects(operation, /cancelled/);
  assert.throws(() => service.dispatch("process/spawn", spawn), /already exists/);
  assert.deepEqual(service.dispatch("process/list", {}), { processes: [] });
  await service.close(); await rejected; assert.equal(requested, 1);
});

test("Host terminal consumes remote handles for output, input, resize and environment cleanup", async () => {
  let command: SandboxCommand | undefined, destroyed = 0;
  const inputs: number[][] = [], sizes: unknown[] = [], notifications: Array<{ method: string; params: any }> = [];
  let exit!: (value: SandboxExit) => void;
  const exited = new Promise<SandboxExit>(resolve => { exit = resolve; });
  const backend: SandboxBackend = {
    id: "remote-terminal-test", async initialize() {}, async close() {},
    async create(_, resources) {
      return { resources, capabilities: { terminal: true },
        async spawn(selected, onOutput) {
          command = selected; onOutput?.({ stream: "stdout", data: new TextEncoder().encode("remote-ready") });
          return { id: "remote-execution", kind: "terminal", exited,
            async writeStdin(data) { inputs.push([...data]); }, async resize(size) { sizes.push(size); }, async terminate() { exit({ code: 143 }); } };
        }, async close() { destroyed++; exit({ code: 0 }); },
      };
    },
  };
  const pool = await createSandboxPool({ id: "host-test", capacity: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 } }, backend);
  const service = new HostProcessService(undefined, pool, { SELECTED: "explicit-value" });
  const old = process.env.OPENCRAFT_TEST_HOST_SECRET; process.env.OPENCRAFT_TEST_HOST_SECRET = "must-stay-on-host";
  service.subscribe((method, params) => notifications.push({ method, params }));
  try {
    assert.deepEqual(await service.dispatch("process/spawn", { ...spawn, cwd: "/remote/project" }), { processHandle: "terminal" });
    assert.equal(command!.cwd, "/remote/project"); assert.equal(command!.env.SELECTED, "explicit-value");
    assert.equal(command!.env.OPENCRAFT_TEST_HOST_SECRET, undefined);
    assert.equal(Buffer.from(notifications[0]!.params.deltaBase64, "base64").toString(), "remote-ready");
    await service.dispatch("process/writeStdin", { processHandle: "terminal", deltaBase64: Buffer.from("hello").toString("base64") });
    await service.dispatch("process/resizePty", { processHandle: "terminal", size: { cols: 120, rows: 40 } });
    assert.deepEqual(inputs, [[...Buffer.from("hello")]]); assert.deepEqual(sizes, [{ cols: 120, rows: 40 }]);
    await service.dispatch("process/kill", { processHandle: "terminal" }); assert.equal(destroyed, 1);
  } finally {
    if (old === undefined) delete process.env.OPENCRAFT_TEST_HOST_SECRET; else process.env.OPENCRAFT_TEST_HOST_SECRET = old;
    await service.close(); await pool.close();
  }
});


test("sandbox terminal preserves account/project ownership and context", async () => {
  const runtime = { snapshot(scope: any) { return { owner: JSON.stringify([scope.account, scope.hostId, scope.projectId]), apply: (env: any) => env, overlay: () => ({}) }; } } as any;
  const scope = (account: string, projectId = "project") => ({ account, hostId: "host", projectId, threadId: null });
  let exit!: (outcome: SandboxExit) => void;
  const exited = new Promise<SandboxExit>(resolve => { exit = resolve; });
  const pool = await createSandboxPool({ id: "ownership", capacity: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 } }, {
    id: "remote-owner-test", async initialize() {}, async close() {}, async create(_, resources) {
      return { resources, capabilities: { terminal: true }, async spawn() { return { id: "opaque", kind: "terminal", exited,
        async writeStdin() {}, async resize() {}, async terminate() { exit({ code: 0 }); } }; }, async close() { exit({ code: 0 }); } };
    },
  });
  const service = new HostProcessService(runtime, pool);
  try {
    await service.dispatch("process/spawn", { ...spawn, resourceOwnerId: "view-owner" }, scope("a"));
    assert.deepEqual(service.dispatch("process/list", {}, scope("b")), { processes: [] });
    assert.throws(() => service.dispatch("process/attach", { processHandle: "terminal", afterSequence: 0 }, scope("b")), /not found/);
    assert.throws(() => service.dispatch("process/kill", { processHandle: "terminal" }, scope("a", "other")), /not found/);
    const attached = service.dispatch("process/attach", { processHandle: "terminal", afterSequence: 0 }, scope("a")) as any;
    assert.equal(attached.context.projectId, "project"); assert.equal(attached.context.resourceOwnerId, "view-owner");
    await service.dispatch("process/kill", { processHandle: "terminal" }, scope("a"));
  } finally { await service.close(); await pool.close(); }
});

test("pending sandbox admissions count against the existing account/Host quota", async () => {
  const { TERMINAL_RESOURCE_LIMITS } = await import("@opencraft/appserver-protocol");
  const { TerminalCapacityError } = await import("../../apps/local-agent-host/src/process-service.js");
  let admissions = 0;
  const pool: SandboxPool = { createSandbox({ signal }) { admissions++; return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(Error("cancelled admission")), { once: true })); }, async close() {} };
  const runtime = { snapshot(scope: any) { return { owner: JSON.stringify([scope.account, scope.hostId, scope.projectId]), apply: (env: any) => env, overlay: () => ({}) }; } } as any;
  const service = new HostProcessService(runtime, pool);
  const pending: Promise<unknown>[] = [];
  const scope = (account: string, projectId: string) => ({ account, hostId: "host", projectId, threadId: null });
  try {
    for (let i = 0; i < TERMINAL_RESOURCE_LIMITS.activePerAccountHost; i++)
      pending.push(Promise.resolve(service.dispatch("process/spawn", { ...spawn, processHandle: "a-" + i }, scope("a", "project-" + i))).catch(error => error));
    assert.throws(() => service.dispatch("process/spawn", { ...spawn, processHandle: "over" }, scope("a", "new-project")), TerminalCapacityError);
    assert.equal(admissions, TERMINAL_RESOURCE_LIMITS.activePerAccountHost);
    if (TERMINAL_RESOURCE_LIMITS.activePerHost > TERMINAL_RESOURCE_LIMITS.activePerAccountHost) {
      pending.push(Promise.resolve(service.dispatch("process/spawn", { ...spawn, processHandle: "b" }, scope("b", "project"))).catch(error => error));
      assert.equal(admissions, TERMINAL_RESOURCE_LIMITS.activePerAccountHost + 1);
    }
  } finally { await service.close(); await Promise.all(pending); }
});
