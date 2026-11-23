import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { createConnection, type Socket } from "node:net";
import { once } from "node:events";
import { createSandbox, createSandboxPool, type SandboxEnvironment } from "@opencraft/sandbox";
import { createSandboxEndpointListener } from "@opencraft/sandbox-node/endpoint-listener";
import { localProcessHarness } from "./fixtures/sandbox-endpoint-backends";

const until = async (condition: () => boolean, ms = 10000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw Error("condition not reached");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
async function setup(t: test.TestContext) {
  const h = await localProcessHarness();
  const pool = await createSandboxPool({ id: "listener", capacity: h.resources, defaults: h.resources }, h.backend);
  const sandbox = await createSandbox(pool, { owner: "listener" });
  t.after(async () => { await h.dispose(); await pool.close().catch(() => {}); });
  return { h, sandbox };
}
const dial = async (path: string) => {
  const socket = createConnection({ path, allowHalfOpen: true });
  await once(socket, "connect");
  return socket;
};
const collect = (socket: Socket) => {
  const chunks: Buffer[] = [];
  socket.on("data", (data: Buffer) => chunks.push(data));
  return { get bytes() { return Buffer.concat(chunks); }, ended: once(socket, "end").then(() => true, () => false) };
};

test("each local connection is a private endpoint connection with binary bytes and half-close", async t => {
  const { h, sandbox } = await setup(t);
  const target = await h.listen(socket => {
    let total = 0;
    socket.on("data", (data: Buffer) => { total += data.length; socket.write(data); });
    socket.on("end", () => socket.end("total:" + total));
  });
  let cleanup = 0;
  const listener = await createSandboxEndpointListener({ sandbox, target: { unix: target }, authorize: async () => {}, onCleanupUnconfirmed: () => { cleanup++; } });
  const client = await dial(listener.path), output = collect(client);
  const payload = Buffer.alloc(200 * 1024).map((_, i) => (i * 13) % 256);
  client.write(payload);
  await until(() => output.bytes.length >= payload.length);
  client.end();
  assert.equal(await output.ended, true);
  assert.ok(output.bytes.equals(Buffer.concat([payload, Buffer.from("total:" + payload.length)])));
  // A second independent connection to the same environment.
  const second = await dial(listener.path), other = collect(second);
  second.end("x");
  await other.ended;
  assert.equal(other.bytes.toString(), "xtotal:1");
  await listener.close();
  await assert.rejects(access(dirname(listener.path)));
  assert.equal(cleanup, 0);
});

test("target close ends the local socket; local close ends the target connection", async t => {
  const { h, sandbox } = await setup(t);
  let targetEnded = false;
  const closing = await h.listen(socket => socket.end("bye"));
  const holding = await h.listen(socket => { socket.on("end", () => { targetEnded = true; socket.end(); }); });
  const a = await createSandboxEndpointListener({ sandbox, target: { unix: closing }, authorize: async () => {}, onCleanupUnconfirmed() {} });
  const b = await createSandboxEndpointListener({ sandbox, target: { unix: holding }, authorize: async () => {}, onCleanupUnconfirmed() {} });
  const first = await dial(a.path), output = collect(first);
  assert.equal(await output.ended, true);
  assert.equal(output.bytes.toString(), "bye");
  const second = await dial(b.path);
  await new Promise(resolve => setTimeout(resolve, 200));
  second.destroy();
  await until(() => targetEnded);
  await Promise.all([a.close(), b.close()]);
});

test("undrained output beyond the bound closes only that connection; limits and authority are enforced", async t => {
  const { h, sandbox } = await setup(t);
  let relayGone = false;
  const flood = await h.listen(socket => {
    const chunk = Buffer.alloc(64 * 1024, 1), pump = () => { while (socket.write(chunk)); };
    socket.on("drain", pump); socket.on("error", () => { relayGone = true; }); socket.on("close", () => { relayGone = true; }); pump();
  });
  const listener = await createSandboxEndpointListener({ sandbox, target: { unix: flood }, authorize: async () => {}, onCleanupUnconfirmed() {}, maxBufferedBytes: 256 * 1024, maxConnections: 1 });
  const client = await dial(listener.path);
  client.pause();
  const closed = once(client, "end");
  const extra = createConnection({ path: listener.path });
  extra.on("error", () => {});
  await once(extra, "close");
  // The paused client cannot observe EOF; the relay being gone is the evidence.
  await until(() => relayGone);
  client.resume();
  await closed;
  // The environment survives: a fresh connection to an echo target works.
  const echo = await h.listen(socket => socket.on("data", data => socket.write(data)));
  let allowed = false;
  const guarded = await createSandboxEndpointListener({ sandbox, target: { unix: echo }, authorize: async () => { if (!allowed) throw Error("revoked"); }, onCleanupUnconfirmed() {} });
  const before = h.commands.length;
  const denied = await dial(guarded.path);
  denied.resume();
  await once(denied, "end");
  assert.equal(h.commands.length, before, "unauthorized connections never spawn");
  allowed = true;
  const ok = await dial(guarded.path), output = collect(ok);
  ok.write("ping");
  await until(() => output.bytes.toString() === "ping");
  await Promise.all([listener.close(), guarded.close()]);
});

test("unconfirmed relay cleanup is reported to the lifecycle owner and fails listener close", async t => {
  const { h, sandbox } = await setup(t);
  const target = await h.listen(socket => socket.on("end", () => socket.end()));
  const stuck: Pick<SandboxEnvironment, "spawn"> = {
    async spawn(command, onOutput) {
      const child = await sandbox.spawn(command, onOutput);
      return { ...child, async terminate() { await child.terminate(); throw Error("unconfirmed"); } } as typeof child;
    },
  };
  let cleanup = 0;
  const listener = await createSandboxEndpointListener({ sandbox: stuck, target: { unix: target }, authorize: async () => {}, onCleanupUnconfirmed: () => { cleanup++; } });
  const client = await dial(listener.path);
  await until(() => h.commands.length > 0);
  client.destroy();
  await until(() => cleanup === 1);
  await assert.rejects(listener.close(), /unconfirmed/);
});
