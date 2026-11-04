import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createSandboxPool, type SandboxBackend, type SandboxCommand } from "@opencraft/sandbox";
import { configuredSandboxPool, parseSandboxRuntimeConfiguration, sandboxPayloadEnvironment, systemdExecutionOwnerProperties } from "@opencraft/sandbox-node/runtime";
import { prepareSandboxInvocation, readSandboxInvocation, forwardSandboxCommand, sandboxMessage, sandboxLifecycleLogger, type SandboxLifecycleEvent } from "@opencraft/sandbox-node/command";
import { configureCodexExecutionSandbox, codexSandboxRequestPolicy } from "../../apps/codex-core/src/execution-sandbox.js";

const selected = { schemaVersion: 1, backend: { id: "remote-test", options: {} }, pool: { idPrefix: "engines" }, environment: { mode: "selected", names: ["PATH", "THREAD"] } };

test("provider selection is explicit and remote payload environments cannot inherit host secrets", async () => {
  const config = parseSandboxRuntimeConfiguration(selected);
  assert.deepEqual(sandboxPayloadEnvironment(config, { PATH: "/task", THREAD: "a", PRIVATE_TOKEN: "secret" }), { PATH: "/task", THREAD: "a" });
  assert.throws(() => parseSandboxRuntimeConfiguration({ ...selected, environment: { mode: "local-inherit" } }));
  await assert.rejects(configuredSandboxPool(config), /not installed/);
});

test("a Linux generation owner can be bounded independently from payload sandbox resources", () => {
  const gib = 1024 ** 3;
  const config = parseSandboxRuntimeConfiguration({schemaVersion: 1,
    backend: {id: "linux-systemd", options: {scope: "system", uid: "current", gid: "current", parentSlice: "opencraft-workloads.slice",
      executionOwner: {cpuMillis: 4000, memoryBytes: 128 * gib, memoryHighBytes: null, tasksMax: 4096, fileDescriptorsPerProcess: 65536}}},
    pool: {idPrefix: "join", capacity: {cpuMillis: 4000, memoryBytes: 8 * gib}}, environment: {mode: "local-inherit"}});
  const properties = systemdExecutionOwnerProperties(config);
  assert(properties.includes("--property=MemoryMax=" + 128 * gib));
  assert.equal(properties.some(value => value.startsWith("--property=MemoryHigh=")), false);
  assert(properties.includes("--slice=opencraft-workloads.slice"));
  assert.equal(config.pool.capacity?.memoryBytes, 8 * gib);
});

test("legacy Linux configurations retain payload-sized generation owner defaults", () => {
  const gib = 1024 ** 3;
  const config = parseSandboxRuntimeConfiguration({schemaVersion: 1,
    backend: {id: "linux-systemd", options: {scope: "system", uid: "current", gid: "current"}},
    pool: {idPrefix: "join"}, environment: {mode: "local-inherit"}});
  const properties = systemdExecutionOwnerProperties(config);
  assert(properties.includes("--property=MemoryMax=" + 8 * gib));
  assert(properties.includes("--property=MemoryHigh=" + 6 * gib));
});

test("generation owner resources reject incomplete or unbounded values", () => {
  const base = {schemaVersion: 1, pool: {idPrefix: "join"}, environment: {mode: "local-inherit"}};
  for (const executionOwner of [
    {cpuMillis: 4000, memoryBytes: 128, memoryHighBytes: null, tasksMax: 4096},
    {cpuMillis: 4000, memoryBytes: 128, memoryHighBytes: 129, tasksMax: 4096, fileDescriptorsPerProcess: 65536},
  ]) assert.throws(() => systemdExecutionOwnerProperties(parseSandboxRuntimeConfiguration({...base,
    backend: {id: "linux-systemd", options: {scope: "system", uid: "current", gid: "current", executionOwner}}})), /invalid/);
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
  const events: SandboxLifecycleEvent[] = [];
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
  const work = forwardSandboxCommand({ pool, owner: "codex", command, input, output, error, lifecycle: event => events.push(event) }); input.end("hello\n");
  assert.equal(await work, 7); assert.equal(text, "hello\n"); assert(eof); assert(closed); await pool.close();
  assert.ok(events.some(e => e.event === "stdin-eof"));
  assert.ok(events.some(e => e.event === "exited" && e.code === 7));
  assert.ok(events.some(e => e.event === "close-requested" && e.reason === "command-finished"));
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



test("lifecycle file excludes payloads, Native error details and unsafe signal metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-lifecycle-")), path = join(root, "lifecycle.jsonl");
  try {
    const log = sandboxLifecycleLogger(path);
    log({event: "exited", code: 137, signal: "SIGKILL", command: "SYNTHETIC_SECRET", env: {token: "SYNTHETIC_SECRET"}, error: "SYNTHETIC_SECRET"} as SandboxLifecycleEvent);
    log({event: "failed", signal: "SYNTHETIC_SECRET", sandboxId: "SYNTHETIC_SECRET"});
    await log.flush();
    const text = await readFile(path, "utf8"), events = text.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(text.includes("SYNTHETIC_SECRET"), false);
    assert.equal(events[0].signal, "SIGKILL"); assert.equal(events[0].code, 137);
    assert.equal((await stat(path)).mode & 0o077, 0);
  } finally {await rm(root, {recursive: true, force: true});}
});

for (const cause of ["abort", "output-close"]) test(`transport lifecycle records ${cause} before cleanup and observes the exit signal`, async () => {
  const events: SandboxLifecycleEvent[] = [], abort = new AbortController();
  let finish!: (exit: {code: number | null; signal: string}) => void;
  const backend: SandboxBackend = {id: "fixture", async initialize() {}, async close() {}, async create(_id, resources) {
    return {resources, capabilities: {terminal: false}, async close() {finish?.({code: null, signal: "SIGTERM"});}, async spawn() {
      return {id: "private", kind: "process", exited: new Promise(resolve => {finish = resolve;}), async writeStdin() {}, async closeStdin() {}, async terminate() {}};
    }};
  }};
  const pool = await createSandboxPool({id: "lifecycle", capacity: {cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3}}, backend);
  const input = new PassThrough(), output = new PassThrough(), error = new PassThrough();
  try {
    const work = forwardSandboxCommand({pool, owner: "codex", command: {command: ["/secret-command"], cwd: "/secret", env: {TOKEN: "SYNTHETIC_SECRET"}}, input, output, error,
      signal: abort.signal, lifecycle: event => events.push(event), onReady() {if (cause === "abort") abort.abort(); else output.destroy();}});
    if (cause === "abort") assert.equal(await work, 128); else await assert.rejects(work, /transport failed/);
    assert.ok(events.some(e => e.event === "close-requested" && e.reason === (cause === "abort" ? "signal" : "output-closed")));
    assert.ok(events.some(e => e.event === "exited" && e.signal === "SIGTERM"));
    assert.equal(JSON.stringify(events).includes("SYNTHETIC_SECRET"), false);
  } finally {await pool.close();}
});

test("systemd lifecycle observes actual service exit code and explicit environment stop", {
  skip: process.env.OPENCRAFT_SANDBOX_LIFECYCLE_TEST !== "1", timeout: 30_000,
}, async () => {
  const {systemdSandboxBackend} = await import("../../packages/sandbox-node/src/systemd.js");
  const events: SandboxLifecycleEvent[] = [];
  const backend = systemdSandboxBackend({scope: "system", uid: 65534, gid: 65534, lifecycle: event => events.push(event)});
  const pool = await createSandboxPool({id: `log-test-${Date.now()}`, capacity: {cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3}}, backend);
  try {
    const sandbox = await pool.createSandbox({owner: "synthetic-lifecycle-test"});
    const exited = await sandbox.spawn({command: ["/usr/bin/sh", "-c", "exit 7"], cwd: "/var/tmp", env: {PATH: "/usr/bin:/bin"}});
    assert.equal((await exited.exited).code, 7);
    assert.ok(events.some(event => event.event === "unit-exited" && event.code === 7 && event.unit?.endsWith(".service")));
    const killed = await sandbox.spawn({command: ["/usr/bin/sh", "-c", "kill -KILL $$"], cwd: "/var/tmp", env: {PATH: "/usr/bin:/bin"}});
    await killed.exited;
    assert.ok(events.some(event => event.event === "unit-exited" && event.exitSignal === 9));
    const sleeping = await sandbox.spawn({command: ["/usr/bin/sleep", "30"], cwd: "/var/tmp", env: {PATH: "/usr/bin:/bin"}});
    await sandbox.close(); await sleeping.exited;
    assert.ok(events.some(event => event.event === "unit-stop" && event.reason === "environment-close"));
  } finally {await pool.close();}
});


test("lifecycle logging never performs synchronous IO and flush preserves event order", async t => {
  const root = await mkdtemp(join(tmpdir(), "oc-async-log-")), path = join(root, "events.jsonl");
  let syncCalls = 0;
  for (const key of ["openSync", "writeSync", "closeSync"] as const) t.mock.method(fs, key, () => {syncCalls++; throw Error("Main thread sync IO forbidden");});
  syncBuiltinESMExports();
  try {
    const log = sandboxLifecycleLogger(path);
    log({event: "starting"}); log({event: "started"}); log({event: "owner-stop", reason: "SIGTERM"});
    assert.equal(syncCalls, 0);
    await log.flush();
    const events = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line).event);
    assert.deepEqual(events, ["starting", "started", "owner-stop"]);
    const unavailable = sandboxLifecycleLogger(join(root, "missing", "events.jsonl"));
    unavailable({event: "failed"}); await unavailable.flush();
  } finally {t.mock.restoreAll(); syncBuiltinESMExports(); await rm(root, {recursive: true, force: true});}
});
