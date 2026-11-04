import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
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
      emit = text => output?.({ stream: "stdout", data: Buffer.from(text) });
      return { id: "opaque", kind: "process", exited: new Promise(resolve => { finish = resolve; }), async writeStdin(data) { received += Buffer.from(data).toString(); },
        async closeStdin() { eof = true; emit?.(received); finish({ code: 7 }); }, async terminate() { finish({ code: 143 }); } };
    } };
  } };
  const pool = await createSandboxPool({ id: "stdio", capacity: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 } }, backend);
  const input = new PassThrough(), output = new PassThrough(), error = new PassThrough(); let text = ""; output.on("data", data => { text += data; });
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
  const policy = codexSandboxRequestPolicy(async id => { reads.push(id); return {thread: {cwd: "/project/recovered"}}; });
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
