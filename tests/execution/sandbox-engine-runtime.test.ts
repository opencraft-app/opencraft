import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createSandboxPool, type SandboxBackend, type SandboxCommand } from "@opencraft/sandbox";
import { configuredSandboxPool, parseSandboxRuntimeConfiguration, sandboxPayloadEnvironment } from "@opencraft/sandbox-node/runtime";
import { prepareSandboxInvocation, readSandboxInvocation, forwardSandboxCommand, sandboxMessage } from "@opencraft/sandbox-node/command";
import { configureCodexExecutionSandbox, codexSandboxRequestPolicy } from "../../apps/codex-core/src/execution-sandbox.js";

const selected = { schemaVersion: 1, backend: { id: "remote-test", options: {} }, pool: { idPrefix: "engines" }, environment: { mode: "selected", names: ["PATH", "THREAD"] } };

test("provider selection is explicit and remote payload environments cannot inherit host secrets", async () => {
  const config = parseSandboxRuntimeConfiguration(selected);
  assert.deepEqual(sandboxPayloadEnvironment(config, { PATH: "/task", THREAD: "a", PRIVATE_TOKEN: "secret" }), { PATH: "/task", THREAD: "a" });
  assert.throws(() => parseSandboxRuntimeConfiguration({ ...selected, environment: { mode: "local-inherit" } }));
  await assert.rejects(configuredSandboxPool(config), /not installed/);
});

test("loader and credential values live in a private payload envelope, never the controller argv or env", async () => {
  const invocation = prepareSandboxInvocation({ runner: "/engine/sandbox-command.mjs", configuration: "/operator/sandbox.json", owner: "dsh",
    command: ["/bin/bash", "--input", "--terminal", "literal;arg"], cwd: "/workspace", env: { NODE_OPTIONS: "--import /task/preload.mjs", PRIVATE_TOKEN: "test-secret", REMOVED: undefined } });
  assert.equal(invocation.env.NODE_OPTIONS, undefined); assert.equal(invocation.env.PRIVATE_TOKEN, undefined);
  assert(!invocation.argv.join(" ").includes("test-secret"));
  const input = new PassThrough();
  const pending = readSandboxInvocation(input);
  input.write(invocation.input);
  const command = await pending;
  assert.deepEqual(command.command, ["/bin/bash", "--input", "--terminal", "literal;arg"]);
  assert.equal(command.env.NODE_OPTIONS, "--import /task/preload.mjs"); assert.equal(command.env.PRIVATE_TOKEN, "test-secret");
  assert(!Object.hasOwn(command.env, "REMOVED"));
});

test("stdio EOF reaches the bounded process and cleanup waits for its whole environment", async () => {
  let eof = false, closed = false, received = "", emit: ((data: string) => void) | undefined;
  let finish!: (exit: { code: number }) => void;
  const backend: SandboxBackend = { id: "test", async initialize() {}, async close() {}, async create(_identity, resources) {
    return { resources, capabilities: { terminal: false }, async close() { closed = true; }, async spawn(_command, output) {
      emit = (text) => output?.({ stream: "stdout", data: Buffer.from(text) });
      return { id: "opaque", kind: "process", exited: new Promise((resolve) => { finish = resolve; }), async writeStdin(data) { received += Buffer.from(data).toString(); },
        async closeStdin() { eof = true; emit?.(received); finish({ code: 7 }); }, async terminate() { finish({ code: 143 }); } };
    } };
  } };
  const pool = await createSandboxPool({ id: "stdio", capacity: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 } }, backend);
  const input = new PassThrough(), output = new PassThrough(), error = new PassThrough(); let text = ""; output.on("data", (data) => { text += data; });
  const command: SandboxCommand = { command: ["/remote/command"], cwd: "/remote", env: {} };
  const work = forwardSandboxCommand({ pool, owner: "codex", command, input, output, error }); input.end("hello\n");
  assert.equal(await work, 7); assert.equal(text, "hello\n"); assert(eof); assert(closed); await pool.close();
});

test("Codex disables direct local execution and preserves an existing operator environment file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-exec-config-test-"));
  try {
    const config = join(directory, "sandbox.json"); await writeFile(config, JSON.stringify(selected), { mode: 0o600 });
    await configureCodexExecutionSandbox(directory, "/official/codex", { configuration: config, runner: "/engine/sandbox-command.mjs" });
    const text = await readFile(join(directory, "environments.toml"), "utf8");
    assert(text.includes("include_local = false")); assert(text.includes('default = "opencraft"')); assert(text.includes('"exec-server"')); assert(text.includes('NODE_OPTIONS = ""'));
    assert.equal((await stat(join(directory, "environments.toml"))).mode & 0o077, 0);
    await writeFile(join(directory, "environments.toml"), "# operator configuration\n");
    await assert.rejects(configureCodexExecutionSandbox(directory, "/official/codex", { configuration: config, runner: "/engine/sandbox-command.mjs" }), /explicit migration/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("transport frames preserve Unicode line separators in schema patterns and task input", () => {
  const message = { pattern: "[^\u2028\u2029]+", input: "a\u2028b\u2029c" };
  const frame = sandboxMessage(message);
  assert.equal(frame.split(/[\r\n\u2028\u2029]/u).length, 2);
  assert.deepEqual(JSON.parse(frame), message);
});

test("Native thread creation and recovered turns select the provider without weakening permissions", async () => {
  const reads: string[] = [];
  const policy = codexSandboxRequestPolicy(async (id) => { reads.push(id); return {thread: {cwd: "/project/recovered"}}; });
  const permission = {type: "workspaceWrite", writableRoots: ["/project/recovered"], networkAccess: false};
  const created = await policy("thread/start", {cwd: "/project/new", sandbox: "workspace-write", approvalPolicy: "on-request", environments: []});
  assert.deepEqual(created.environments, [{environmentId: "opencraft", cwd: "/project/new"}]);
  assert.equal(created.sandbox, "workspace-write"); assert.equal(created.approvalPolicy, "on-request");
  const turn = await policy("turn/start", {threadId: "old", sandboxPolicy: permission, environments: [{environmentId: "local", cwd: "/"}]});
  assert.deepEqual(turn.environments, [{environmentId: "opencraft", cwd: "/project/recovered"}]);
  assert.equal(turn.sandboxPolicy, permission); assert.deepEqual(reads, ["old"]);
  const moved = await policy("turn/start", {threadId: "old", cwd: "/project/moved"});
  assert.deepEqual(moved.environments, [{environmentId: "opencraft", cwd: "/project/moved"}]); assert.deepEqual(reads, ["old"]);
  await assert.rejects(policy("thread/start", {}));
  await assert.rejects(policy("turn/start", {threadId: "old", cwd: "relative"}));
});

test("projectless Codex threads get separate private directories reused by later turns", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-projectless-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const threads = new Map<string, {cwd: unknown}>();
  const workspaceRoot = join(root, "workspaces");
  const policy = codexSandboxRequestPolicy(async (id) => ({thread: threads.get(id)}), workspaceRoot);
  const first = await policy("thread/start", {sandbox: "workspace-write"});
  const second = await policy("thread/start", {});
  assert.match(String(first.cwd), /\/workspaces\/thread-/);
  assert.notEqual(first.cwd, second.cwd);
  assert.equal((await stat(String(first.cwd))).mode & 0o777, 0o700);
  assert.deepEqual(first.runtimeWorkspaceRoots, [first.cwd]);
  assert.equal(first.sandbox, "workspace-write");
  threads.set("one", {cwd: first.cwd});
  assert.deepEqual((await policy("turn/start", {threadId:"one"})).environments,
    [{environmentId:"opencraft", cwd:first.cwd}]);
  await assert.rejects(policy("turn/start", {threadId:"unknown"}), /missing-workspace/);
  await assert.rejects(policy("thread/start", {cwd:"relative"}), /invalid-workspace/);
});

test("sandbox control framing preserves binary stdin after a split header", async () => {
  const invocation = prepareSandboxInvocation({ runner: "/engine/run.mjs", configuration: "/policy.json", owner: "test", command: ["cat"], cwd: "/task", env: {} });
  const stream = new PassThrough(), pending = readSandboxInvocation(stream), data = Buffer.from([0, 255, 10, 17]);
  stream.write(invocation.input.slice(0, 5));
  stream.write(Buffer.concat([Buffer.from(invocation.input.slice(5)), data]));
  assert.deepEqual((await pending).command, ["cat"]);
  assert.deepEqual(stream.read(), data);
  stream.destroy();
});

test("sandbox input rejects truncation, oversized control frames and cancellation", async () => {
  const truncated = new PassThrough(), missing = readSandboxInvocation(truncated);
  truncated.end('{'); await assert.rejects(missing, /unavailable or invalid/);
  const oversized = new PassThrough(), limit = readSandboxInvocation(oversized);
  oversized.write('x'.repeat(384 * 1024)); await assert.rejects(limit, /unavailable or invalid/); oversized.destroy();
  const stream = new PassThrough(), controller = new AbortController(), cancelled = readSandboxInvocation(stream, controller.signal);
  controller.abort(); await assert.rejects(cancelled, /unavailable or invalid/); stream.destroy();
});

test("trusted bound requests keep remote execution and caller permission policy", async () => {
  let reads = 0,
    checks = 0;
  const policy = codexSandboxRequestPolicy(
    async () => {
      reads++;
      throw Error("must not read local cwd");
    },
    "/must-not-create",
    undefined,
    async () => ({
      kind: "bound",
      binding: {
        async executionFields() {
          checks++;
          return { cwd: "/workspace", environments: [{ environmentId: "workspace-test", cwd: "/workspace" }] };
        },
      },
    }),
  );
  const sandboxPolicy = { type: "workspaceWrite", writableRoots: ["/workspace"], networkAccess: false };
  for (const method of ["thread/start", "turn/start"]) {
    const input = {
      threadId: "thread-a",
      sandboxPolicy,
      approvalPolicy: "on-request",
      environments: [{ environmentId: "local", cwd: "/" }],
    };
    const result = await policy(method, input);
    assert.deepEqual(result.environments, [{ environmentId: "workspace-test", cwd: "/workspace" }]);
    assert.equal(result.cwd, "/workspace");
    assert.deepEqual(result.runtimeWorkspaceRoots, ["/workspace"]);
    assert.equal(result.sandboxPolicy, sandboxPolicy);
    assert.equal(result.approvalPolicy, "on-request");
    assert.equal(input.environments[0].environmentId, "local");
  }
  assert.equal(reads, 0);
  assert.equal(checks, 2);
});

test("bound workspace rejects conflicting cwd/roots instead of widening or executing locally", async () => {
  const policy = codexSandboxRequestPolicy(
    async () => {
      throw Error("local read");
    },
    undefined,
    undefined,
    async () => ({
      kind: "bound",
      binding: {
        async executionFields() {
          return { cwd: "/workspace", environments: [{ environmentId: "workspace-test", cwd: "/workspace" }] };
        },
      },
    }),
  );
  for (const params of [
    { cwd: "/local" },
    { runtimeWorkspaceRoots: ["/"] },
    { runtimeWorkspaceRoots: ["/workspace", "/shared"] },
  ])
    await assert.rejects(policy("thread/start", params), /workspace-binding-conflict/);
  assert.equal(
    (await policy("thread/start", { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] })).cwd,
    "/workspace",
  );
});

test("missing or revoked binding fails closed with sanitized diagnostics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bound-no-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, "never-created");
  const failure = async () => {
    throw Error("PRIVATE_TOKEN_AND_PROVIDER_URL");
  };
  for (const resolve of [
    failure,
    async () => undefined as any,
    async () => ({ kind: "bound" as const, binding: { executionFields: failure } }),
  ]) {
    const policy = codexSandboxRequestPolicy(failure, local, undefined, resolve);
    await assert.rejects(
      policy("thread/start", {}),
      (error) => error instanceof Error && error.message === "workspace-binding-unavailable",
    );
    await assert.rejects(stat(local), { code: "ENOENT" });
  }
});

test("invalid owner execution fields cannot select native local or escape workspace", async () => {
  for (const fields of [
    { cwd: "/workspace", environments: [{ environmentId: "local", cwd: "/workspace" }] },
    { cwd: "/workspace", environments: [{ environmentId: "workspace-ok", cwd: "/" }] },
    { cwd: "/workspace/../etc", environments: [{ environmentId: "workspace-ok", cwd: "/workspace/../etc" }] },
    { cwd: "/workspace", environments: [] },
  ]) {
    const policy = codexSandboxRequestPolicy(
      async () => null,
      undefined,
      undefined,
      async () => ({
        kind: "bound",
        binding: {
          async executionFields() {
            return fields;
          },
        },
      }),
    );
    await assert.rejects(policy("thread/start", {}), /invalid-workspace-binding/);
  }
});

test("explicit local classification preserves local behavior and nonexecution calls bypass resolver", async () => {
  let resolves = 0;
  const policy = codexSandboxRequestPolicy(
    async () => ({ thread: { cwd: "/local" } }),
    undefined,
    undefined,
    async () => {
      resolves++;
      return { kind: "local" };
    },
  );
  assert.deepEqual((await policy("turn/start", { threadId: "local-thread" })).environments, [
    { environmentId: "opencraft", cwd: "/local" },
  ]);
  const input = { threadId: "x" };
  assert.equal(await policy("thread/read", input), input);
  assert.equal(resolves, 1);
});

test("bound resume reauthorizes execution and rejects alternate history/path sources", async () => {
  let checked = 0;
  const policy = codexSandboxRequestPolicy(
    async () => {
      throw Error("local read forbidden");
    },
    undefined,
    undefined,
    async (method) => {
      assert.equal(method, "thread/resume");
      checked++;
      return {
        kind: "bound",
        binding: {
          async executionFields() {
            return { cwd: "/workspace", environments: [{ environmentId: "workspace-stable", cwd: "/workspace" }] };
          },
        },
      };
    },
  );
  const bound = await policy("thread/resume", { threadId: "thread", excludeTurns: true });
  assert.equal(bound.cwd, "/workspace");
  assert.equal(bound.excludeTurns, true);
  assert.deepEqual(bound.environments, [{ environmentId: "workspace-stable", cwd: "/workspace" }]);
  for (const input of [{ path: "/other/rollout" }, { history: [] }])
    await assert.rejects(policy("thread/resume", { threadId: "thread", ...input }), /workspace-binding-conflict/);
  assert.equal(checked, 3);
  const missing = codexSandboxRequestPolicy(
    async () => null,
    undefined,
    undefined,
    async () => {
      throw Error("missing");
    },
  );
  await assert.rejects(missing("thread/resume", { threadId: "thread" }), /workspace-binding-unavailable/);
  const params = { threadId: "local", path: "/local/history" };
  assert.equal(await codexSandboxRequestPolicy(async () => null)("thread/resume", params), params);
  assert.equal(
    await codexSandboxRequestPolicy(
      async () => null,
      undefined,
      undefined,
      async () => ({ kind: "local" }),
    )("thread/resume", params),
    params,
  );
});

test("bound execution registers with the final Native target, not a current-generation router", async () => {
  const calls: string[] = [];
  const fields = { cwd: "/workspace", environments: [{ environmentId: "workspace-stable", cwd: "/workspace" }] };
  const binding = {
    async executionFields() {
      calls.push("authorize");
      return fields;
    },
    async registerExecutionEnvironment(request: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
      await request("environment/add", { environmentId: fields.environments[0].environmentId });
    },
  };
  for (const target of ["old-generation", "current-generation"]) {
    const policy = codexSandboxRequestPolicy(
      async () => {
        throw Error("local fallback");
      },
      undefined,
      undefined,
      async () => ({ kind: "bound", binding }),
      async (method) => {
        calls.push(target + ":" + method);
      },
    );
    for (const method of ["thread/start", "thread/resume", "turn/start"]) {
      calls.length = 0;
      const result = await policy(method, { threadId: "persisted-thread", approvalPolicy: "never" });
      assert.deepEqual(calls, ["authorize", target + ":environment/add", "authorize"]);
      assert.equal(result.approvalPolicy, "never");
      assert.deepEqual(result.environments, fields.environments);
    }
  }
});

test("missing final Native channel and failed registration cannot fall back to local execution", async () => {
  let registrations = 0;
  const binding = {
    async executionFields() {
      return { cwd: "/workspace", environments: [{ environmentId: "workspace-stable", cwd: "/workspace" }] };
    },
    async registerExecutionEnvironment() {
      registrations++;
      throw Error("private transport secret");
    },
  };
  for (const request of [undefined, async () => null]) {
    const policy = codexSandboxRequestPolicy(
      async () => {
        throw Error("local fallback");
      },
      undefined,
      undefined,
      async () => ({ kind: "bound", binding }),
      request,
    );
    await assert.rejects(policy("turn/start", { threadId: "thread" }), { message: "workspace-binding-unavailable" });
  }
  assert.equal(registrations, 1);
});

test("authorization loss or incarnation change during registration blocks forwarding", async () => {
  for (const failure of ["revoked", "changed"]) {
    let registered = false;
    const binding = {
      async executionFields() {
        if (registered && failure === "revoked") throw Error("revoked private details");
        return {
          cwd: "/workspace",
          environments: [{ environmentId: registered ? "workspace-new" : "workspace-old", cwd: "/workspace" }],
        };
      },
      async registerExecutionEnvironment() {
        registered = true;
      },
    };
    const policy = codexSandboxRequestPolicy(
      async () => null,
      undefined,
      undefined,
      async () => ({ kind: "bound", binding }),
      async () => null,
    );
    await assert.rejects(policy("thread/resume", { threadId: "thread" }), { message: "workspace-binding-unavailable" });
  }
});

test("conflicting workspace input is rejected before any Native registration", async () => {
  let registered = false;
  const binding = {
    async executionFields() {
      return { cwd: "/workspace", environments: [{ environmentId: "workspace-stable", cwd: "/workspace" }] };
    },
    async registerExecutionEnvironment() {
      registered = true;
    },
  };
  const policy = codexSandboxRequestPolicy(
    async () => null,
    undefined,
    undefined,
    async () => ({ kind: "bound", binding }),
    async () => null,
  );
  await assert.rejects(policy("thread/start", { cwd: "/other" }), /workspace-binding-conflict/);
  assert.equal(registered, false);
});
