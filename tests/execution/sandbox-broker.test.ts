import test from "node:test";
import assert from "node:assert/strict";
import { SandboxFault, type SandboxCommand, type SandboxOutput } from "@opencraft/sandbox";
import { brokerSource, startBrokerProcess, type SandboxBrokerChannel } from "@opencraft/sandbox/broker";
import { createSandboxProviderRegistry } from "@opencraft/sandbox/providers";

type Frame = { type: string; [key: string]: unknown };
/** In-memory provider transport: records host frames and lets the test speak as the broker. */
function fakeTransport(options: { reject?: (frame: Frame) => boolean } = {}) {
  const frames: Frame[] = [];
  let stdout!: (chunk: string) => void, end!: () => void;
  const ended = new Promise<void>((resolve) => (end = resolve));
  let closes = 0;
  const handlers: ((frame: Frame) => void)[] = [];
  return {
    frames,
    get closes() {
      return closes;
    },
    emit: (value: unknown) => stdout(JSON.stringify(value) + "\n"),
    raw: (chunk: string) => stdout(chunk),
    end,
    on: (handler: (frame: Frame) => void) => handlers.push(handler),
    options: (command: SandboxCommand, output: SandboxOutput[], requestTimeoutMs = 5000) => ({
      id: "process-1",
      command,
      onOutput: (o: SandboxOutput) => output.push(o),
      requestTimeoutMs,
      label: "Fake",
      closeEnvironment: async () => {
        closes++;
      },
      launch: async (onStdout: (chunk: string) => void): Promise<SandboxBrokerChannel> => {
        stdout = onStdout;
        return {
          ended,
          write: async (line: string) => {
            assert.ok(line.endsWith("\n"));
            const frame = JSON.parse(line) as Frame;
            if (options.reject?.(frame)) throw Error("synthetic transport rejection");
            frames.push(frame);
            for (const handler of handlers) handler(frame);
          },
        };
      },
    }),
  };
}
const pipe: SandboxCommand = { command: ["/bin/cat"], cwd: "/workspace", env: { A: "1" } };
const terminal: SandboxCommand = { ...pipe, terminal: { cols: 80, rows: 24 } };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("the neutral broker module carries the broker program and no provider types", () => {
  assert.match(brokerSource, /^import base64,errno,fcntl,json,os,pty/);
  assert.match(brokerSource, /os\.killpg\(child\.pid,signal\.SIGKILL\)/);
  assert.match(brokerSource, /readline\(400001\)/);
});

test("pipe process: start frame, binary stdin in bounded chunks, EOF, split output lines and exit", async () => {
  const t = fakeTransport(),
    output: SandboxOutput[] = [];
  t.on((frame) => {
    if (frame.type === "start") queueMicrotask(() => t.emit({ type: "started" }));
  });
  const process = await startBrokerProcess(t.options(pipe, output));
  assert.equal(process.kind, "process");
  assert.equal(process.id, "process-1");
  assert.deepEqual(t.frames[0], { type: "start", command: pipe });
  const payload = new Uint8Array(128 * 1024 + 300).map((_, i) => i % 256);
  await process.writeStdin(payload);
  const stdin = t.frames.filter((f) => f.type === "stdin");
  assert.equal(stdin.length, 2);
  const received = Buffer.concat(stdin.map((f) => Buffer.from(f.data as string, "base64")));
  assert.deepEqual(new Uint8Array(received), payload);
  if (process.kind !== "process") throw Error("expected pipe");
  await process.closeStdin();
  await process.closeStdin();
  assert.equal(t.frames.filter((f) => f.type === "eof").length, 1);
  await assert.rejects(process.writeStdin(new Uint8Array([1])), (e) => e instanceof SandboxFault && e.code === "SANDBOX_CLOSED");
  const binary = Buffer.from([0, 255, 10, 13, 0x80]);
  const line = JSON.stringify({ type: "output", stream: "stderr", data: binary.toString("base64") }) + "\n";
  t.raw(line.slice(0, 7));
  t.raw(line.slice(7) + JSON.stringify({ type: "output", stream: "stdout", data: "YQ==" }) + "\n");
  t.emit({ type: "exit", code: 3, signal: null });
  assert.deepEqual(await process.exited, { code: 3 });
  assert.deepEqual(
    output.map((o) => [o.stream, [...o.data]]),
    [
      ["stderr", [...binary]],
      ["stdout", [97]],
    ],
  );
  assert.equal(t.closes, 0);
  await process.terminate(); // Already finished: no frame, no teardown.
  assert.equal(t.frames.filter((f) => f.type === "terminate").length, 0);
});

test("terminal process: single stream, resize, invalid size rejected locally, terminate kills the group", async () => {
  const t = fakeTransport(),
    output: SandboxOutput[] = [];
  t.on((frame) => {
    if (frame.type === "start") queueMicrotask(() => t.emit({ type: "started" }));
    if (frame.type === "terminate") queueMicrotask(() => t.emit({ type: "exit", code: null, signal: "SIGKILL" }));
  });
  const process = await startBrokerProcess(t.options(terminal, output));
  assert.equal(process.kind, "terminal");
  if (process.kind !== "terminal") throw Error("expected terminal");
  assert.equal("closeStdin" in process, false);
  await process.resize({ cols: 120, rows: 40 });
  assert.deepEqual(t.frames.at(-1), { type: "resize", size: { cols: 120, rows: 40 } });
  await assert.rejects(process.resize({ cols: 0, rows: 40 }), (e) => e instanceof SandboxFault && e.code === "SANDBOX_POLICY");
  assert.equal(t.frames.filter((f) => f.type === "resize").length, 1);
  await process.terminate();
  assert.deepEqual(await process.exited, { code: null, signal: "SIGKILL" });
  assert.equal(t.closes, 0);
});

test("transport loss before exit fails the process, retires the environment and never replays input", async () => {
  const t = fakeTransport();
  t.on((frame) => {
    if (frame.type === "start") queueMicrotask(() => t.emit({ type: "started" }));
  });
  const process = await startBrokerProcess(t.options(pipe, []));
  t.end();
  await assert.rejects(process.exited, (e) => e instanceof SandboxFault && e.code === "SANDBOX_START");
  await tick();
  assert.equal(t.closes, 1);
  const before = t.frames.length;
  await assert.rejects(process.writeStdin(new Uint8Array([1])), (e) => e instanceof SandboxFault && e.code === "SANDBOX_CLOSED");
  assert.equal(t.frames.length, before);
});

test("attached process: transport loss, startup failure and unacknowledged terminate end only that process", async () => {
  const attached: SandboxCommand = { ...pipe, attached: true };
  const t = fakeTransport();
  t.on((frame) => {
    if (frame.type === "start") queueMicrotask(() => t.emit({ type: "started" }));
  });
  const process = await startBrokerProcess(t.options(attached, []));
  // Host-side lifetime only: the guest broker receives the plain command.
  assert.deepEqual(t.frames[0], { type: "start", command: pipe });
  t.end();
  await assert.rejects(process.exited, (e) => e instanceof SandboxFault && e.code === "SANDBOX_START");
  await tick();
  assert.equal(t.closes, 0, "attached transport loss never retires the environment");
  await assert.rejects(process.writeStdin(new Uint8Array([1])), (e) => e instanceof SandboxFault && e.code === "SANDBOX_CLOSED");

  const malformed = fakeTransport();
  malformed.on((frame) => {
    if (frame.type === "start") queueMicrotask(() => malformed.raw("not-json\n"));
  });
  await assert.rejects(startBrokerProcess(malformed.options(attached, [])), (e) => e instanceof SandboxFault && e.code === "SANDBOX_START");
  await tick();
  assert.equal(malformed.closes, 0);

  const u = fakeTransport({ reject: (frame) => frame.type === "terminate" });
  u.on((frame) => {
    if (frame.type === "start") queueMicrotask(() => u.emit({ type: "started" }));
  });
  const stuck = await startBrokerProcess(u.options(attached, [], 1000));
  await assert.rejects(stuck.terminate(), (e) => e instanceof SandboxFault && e.code === "SANDBOX_CLEANUP");
  await assert.rejects(stuck.exited, (e) => e instanceof SandboxFault);
  await tick();
  assert.equal(u.closes, 0, "unconfirmed attached termination is reported, not escalated to environment teardown");

  // The default lifetime keeps failing closed on the same transport loss.
  const strict = fakeTransport();
  strict.on((frame) => {
    if (frame.type === "start") queueMicrotask(() => strict.emit({ type: "started" }));
  });
  await startBrokerProcess(strict.options(pipe, []));
  strict.end();
  await tick();
  assert.equal(strict.closes, 1);
});

test("malformed or out-of-order broker frames and oversized start fail closed", async () => {
  for (const reply of ['{"type":"output","stream":"stdout","data":"YQ=="}\n', "not-json\n", '{"type":"exit","code":"x"}\n']) {
    const t = fakeTransport();
    t.on((frame) => {
      if (frame.type === "start") queueMicrotask(() => t.raw(reply));
    });
    await assert.rejects(
      startBrokerProcess(t.options(pipe, [])),
      (e) => e instanceof SandboxFault && e.code === "SANDBOX_START" && e.message === "Fake process could not start",
    );
    await tick();
    assert.equal(t.closes, 1);
  }
  const t = fakeTransport();
  await assert.rejects(
    startBrokerProcess(t.options({ ...pipe, env: { BIG: "x".repeat(400 * 1024) } }, [])),
    (e) => e instanceof SandboxFault && e.code === "SANDBOX_START",
  );
  assert.equal(t.frames.length, 0);
});

test("a rejected EOF is accepted only when the framed exit arrives; unacknowledged terminate tears down", async () => {
  const t = fakeTransport({ reject: (frame) => frame.type === "eof" || frame.type === "terminate" });
  t.on((frame) => {
    if (frame.type === "start") queueMicrotask(() => t.emit({ type: "started" }));
  });
  const process = await startBrokerProcess(t.options(pipe, []));
  if (process.kind !== "process") throw Error("expected pipe");
  setTimeout(() => t.emit({ type: "exit", code: 0, signal: null }), 20);
  await process.closeStdin();
  assert.deepEqual(await process.exited, { code: 0 });

  const u = fakeTransport({ reject: (frame) => frame.type === "terminate" });
  u.on((frame) => {
    if (frame.type === "start") queueMicrotask(() => u.emit({ type: "started" }));
  });
  const stuck = await startBrokerProcess(u.options(pipe, [], 1000));
  await assert.rejects(stuck.terminate(), (e) => e instanceof SandboxFault && e.code === "SANDBOX_START");
  assert.ok(u.closes >= 1);
});

test("provider registry resolves by configured backend and fails closed otherwise", () => {
  type Installation = { backend: "alpha"; endpoint: string } | { backend: "beta"; region: string };
  const backend = (id: string) => ({ id, initialize: async () => {}, create: async () => Promise.reject(Error()), close: async () => {} });
  const persistent = {
    receipt: async () => ({ instanceId: "i", privateVolumeId: "v" }),
    inspect: async () => "unknown" as const,
    verifyMounts: async () => ({ cwd: "/workspace" as const }),
  };
  const registry = createSandboxProviderRegistry<Installation>({
    alpha: { id: "alpha", createBackend: (r) => backend(r.installation.backend), persistentWorkspaces: persistent },
    beta: { id: "beta", createBackend: () => backend("beta") },
  });
  assert.deepEqual(registry.ids(), ["alpha", "beta"]);
  assert.equal(registry.resolve({ backend: "alpha", endpoint: "x" }).id, "alpha");
  assert.equal(registry.persistent({ backend: "alpha", endpoint: "x" }), registry.persistent({ backend: "alpha", endpoint: "y" }));
  assert.equal(registry.supports("alpha", "persistentWorkspaces"), true);
  assert.equal(registry.supports("beta"), true);
  assert.equal(registry.supports("beta", "persistentWorkspaces"), false);
  assert.equal(registry.supports("e2b"), false);
  const unavailable = (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_UNAVAILABLE";
  assert.throws(() => registry.persistent({ backend: "beta", region: "r" }), unavailable);
  for (const raw of [{ backend: "e2b" }, { backend: "toString" }, { backend: "__proto__" }, {}, null])
    assert.throws(() => registry.resolve(raw as never), unavailable);
  const empty = createSandboxProviderRegistry<Installation>({});
  assert.deepEqual(empty.ids(), []);
  assert.throws(() => empty.resolve({ backend: "alpha", endpoint: "x" }), unavailable);
  const policy = (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_POLICY";
  assert.throws(() => createSandboxProviderRegistry({ alpha: { id: "beta", createBackend: () => backend("beta") } } as never), policy);
  assert.throws(
    () => createSandboxProviderRegistry({ ["x".repeat(24)]: { id: "x".repeat(24), createBackend: () => backend("x") } } as never),
    policy,
  );
});
