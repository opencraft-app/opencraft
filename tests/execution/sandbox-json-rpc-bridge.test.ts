import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import type { SandboxOutput, SandboxProcess } from "@opencraft/sandbox";
import { createSandboxJsonRpcBridge } from "../../packages/sandbox-node/src/json-rpc-bridge";
const command = { command: ["/sandbox/codex", "exec-server", "--listen", "stdio"], cwd: "/workspace", env: {} };
const delay = () => new Promise(r => setTimeout(r, 10));
async function connect(url: string) {
  const client = new WebSocket(url);
  await new Promise<void>((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
  return client;
}
function fixture() {
  let output: ((v: SandboxOutput) => void) | undefined, end!: () => void;
  const input: string[] = []; let spawns = 0, terminations = 0, lost = 0, allowed = true;
  const exited = new Promise<{ code: number }>(resolve => { end = () => resolve({ code: 0 }); });
  const child: SandboxProcess = { kind: "process", id: "opaque", exited,
    async writeStdin(d) { input.push(Buffer.from(d).toString()); }, async closeStdin() {},
    async terminate() { terminations++; end(); },
  };
  return { input, child, end: () => end(), deny: () => { allowed = false; },
    get spawns() { return spawns; }, get terminations() { return terminations; }, get lost() { return lost; },
    emit: (v: string | Buffer) => output!({ stream: "stdout", data: Buffer.from(v) }),
    options: { command, sandbox: { async spawn(c: typeof command, out?: (o: SandboxOutput) => void) {
      assert.deepEqual(c, command); spawns++; output = out; return child;
    } }, async authorize() { if (!allowed) throw Error("revoked"); }, onLost() { lost++; } },
  };
}
test("private transport preserves JSON frames and split UTF8, without allocating a sandbox", async () => {
  const f = fixture(), bridge = await createSandboxJsonRpcBridge(f.options);
  assert.equal(f.spawns, 0);
  const c = await connect(bridge.url);
  try {
    c.send(JSON.stringify({ id: 1, method: "initialize" })); await delay();
    assert.deepEqual(f.input, ['{"id":1,"method":"initialize"}\n']);
    const received = new Promise(r => c.once("message", d => r(d.toString())));
    const raw = Buffer.from('{"id":1,"result":"资料"}\n');
    f.emit(raw.subarray(0,20)); f.emit(raw.subarray(20));
    assert.equal(await received, '{"id":1,"result":"资料"}');
  } finally { await bridge.close(); c.terminate(); }
  assert.equal(f.spawns, 1); assert.equal(f.terminations, 1); assert.equal(f.lost, 0);
});
test("unknown capability and duplicate connections cannot spawn execution", async () => {
  const f = fixture(), b = await createSandboxJsonRpcBridge(f.options);
  try {
    await assert.rejects(connect(b.url.replace(/.$/, 'x')));
    assert.equal(f.spawns, 0);
    const c = await connect(b.url); await delay();
    await assert.rejects(connect(b.url)); assert.equal(f.spawns, 1); c.terminate();
  } finally { await b.close(); }
});
test("revocation before a request retires transport without forwarding it", async () => {
  const f = fixture(), b = await createSandboxJsonRpcBridge(f.options), c = await connect(b.url);
  await delay(); f.deny(); c.send('{"id":2,"method":"exec"}'); await delay();
  await b.close(); assert.equal(f.input.length, 0); assert.equal(f.lost, 1); assert.equal(f.terminations, 1);
});
test("remote exit retires the URL; no reconnect or local fallback", async () => {
  const f = fixture(), b = await createSandboxJsonRpcBridge(f.options), c = await connect(b.url);
  await delay(); f.end(); await delay(); await b.close();
  await assert.rejects(connect(b.url)); assert.equal(f.spawns, 1); assert.equal(f.lost, 1); c.terminate();
});
test("newline injection and malformed output fail closed", async () => {
  for (const incoming of [true, false]) {
    const f = fixture(), b = await createSandboxJsonRpcBridge(f.options), c = await connect(b.url);
    await delay();
    if (incoming) c.send('{"id":1}\n{"id":2}'); else f.emit('not json\n');
    await delay(); await b.close(); assert.equal(f.lost, 1); assert.equal(f.input.length, 0); c.terminate();
  }
});
test("cancel during spawn reclaims the late process and never forwards queued messages", async () => {
  const f = fixture(); let resolve!: (p: SandboxProcess) => void;
  const controller = new AbortController();
  const b = await createSandboxJsonRpcBridge({ ...f.options, signal: controller.signal,
    sandbox: { spawn: async () => new Promise(r => { resolve = r; }) } });
  const c = await connect(b.url); c.send('{"id":1}'); await delay(); controller.abort(); resolve(f.child);
  await b.close(); assert.equal(f.terminations, 1); assert.equal(f.input.length, 0); c.terminate();
});
test("unconfirmed process cleanup is observable to the lease owner", async () => {
  const f = fixture(); f.child.terminate = async () => { throw Error('cleanup_unconfirmed'); };
  const b = await createSandboxJsonRpcBridge(f.options), c = await connect(b.url); await delay();
  await assert.rejects(b.close(), /cleanup_unconfirmed/); c.terminate();
});
