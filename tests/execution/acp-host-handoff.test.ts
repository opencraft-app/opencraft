import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { AcpGenerationHost } from "../../plugins/acp-engine/src/generations.js";
import { AcpHostHandoff } from "../../plugins/acp-engine/src/host-handoff.js";
import { AcpStdioTransport } from "../../plugins/acp-engine/src/transport.js";
const client = { notify() {}, async request() { throw new Error("unexpected callback"); } };
async function fixture(t: any, exitOn?: string) {
  const root = await mkdtemp(join(tmpdir(), "acp-host-handoff-")), trace = join(root, "trace"), hosts: AcpGenerationHost[] = [];
  const peer = join(root, "peer.mjs");
  let peerSource = await readFile(resolve("tests/fixtures/acp-engine-peer.mjs"), "utf8");
  if (exitOn) peerSource = peerSource.replace("const frame = JSON.parse(line); trace(frame);", `const frame = JSON.parse(line); trace(frame); if(frame.method === ${JSON.stringify(exitOn)}) process.exit(0);`);
  await writeFile(peer, peerSource);
  const create = () => {
    const host = new AcpGenerationHost({ id: "acp", dataDirectory: root, inspectOsWork: () => ({ coverage: "complete", activeCount: 0 }), initialGeneration: { id: "a", configPath: "/private/fixed-a.json" },
      async readConfig() { return { command: process.execPath, args: [peer], cwd: root, env: { ACP_TEST_TRACE: trace }, permission: "allow-once" }; } });
    hosts.push(host); return host;
  };
  t.after(async () => { for (const host of hosts) await host.close(); await rm(root, { recursive: true, force: true }); });
  const host = create(); await host.start();
  const expectation = (h = host) => ({ expectedOwner: h.ownerIncarnation, expectedEpoch: h.snapshot().handoff.epoch, operationId: "handoff-one", fence: "fence-one" });
  return { root, peer, trace, host, create, expectation };
}
async function until(predicate: () => boolean) { for (let n = 0; n < 300; n++) { if (predicate()) return; await delay(10); } throw new Error("fixture timeout"); }
test("ACP Host drains callback once, releases native writer, cold reads bindings and requires exact successor readiness", async t => {
  const { host, create, trace, expectation } = await fixture(t);
  let calls = 0, finish!: () => void;
  const held = new Promise<void>(r => { finish = r; });
  host.setOrchestration({ tools: [{ name: "thread_spawn", description: "fixture", inputSchema: { type: "object" } }], async call() { calls++; await held; return { id: "one-child" }; } });
  const thread = (await host.request("thread/start", {}, client)).thread.id;
  await host.request("turn/start", { threadId: thread, input: [{ type: "text", text: "call:thread_spawn" }] }, client);
  await until(() => calls === 1);
  const nativePid = host.snapshot().generations[0].pid;
  const fenced = await host.ownerControl("fence", expectation());
  assert.equal(fenced.handoff.phase, "fenced"); assert.ok(fenced.occupancy.activeCount > 0);
  await assert.rejects(host.request("thread/start", {}, client), /fenced/);
  await assert.rejects(host.request("turn/start", { threadId: thread, input: [] }, client), /fenced/);
  await assert.rejects(host.manage("add", { id: "b", configPath: "/private/b.json" }), /fenced/);
  await assert.rejects(host.inputs.submit(thread, "new-input", "unexpected", () => true), /fenced/);
  await assert.rejects(host.ownerControl("release", expectation()), /not drained/);
  assert.equal(host.snapshot().generations[0].pid, nativePid);
  finish(); await until(() => host.occupancy().activeCount === 0);
  const released = await host.ownerControl("release", expectation());
  assert.equal(released.handoff.phase, "released"); assert.equal(released.generations[0].pid, null);
  await assert.rejects(host.request("thread/resume", { threadId: thread }, client), /fenced/);
  await host.close();
  const successor = create(); await successor.start();
  assert.equal(successor.snapshot().handoff.phase, "released"); assert.notEqual(successor.snapshot().generations[0].pid, nativePid);
  await assert.rejects(successor.request("thread/start", {}, client), /fenced/);
  await assert.rejects(successor.ownerControl("resume", expectation(successor)), /readiness/);
  const ready = await successor.ownerControl("cold-ready", expectation(successor));
  await assert.rejects(successor.ownerControl("resume", { ...expectation(successor), identity: "wrong" }), /readiness/);
  await assert.rejects(successor.ownerControl("resume", { ...expectation(successor), expectedOwner: host.ownerIncarnation, identity: ready.handoff.ready.identity }), /conflict/);
  await successor.ownerControl("resume", { ...expectation(successor), identity: ready.handoff.ready.identity });
  await successor.request("thread/resume", { threadId: thread }, client);
  const events = (await readFile(trace, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  for (const method of ["session/new", "session/prompt", "session/resume"]) assert.equal(events.filter(e => e.method === method).length, 1);
  assert.equal(calls, 1);
});
test("fenced crash without release fails closed", async t => {
  const { host, create, expectation } = await fixture(t);
  await host.ownerControl("fence", expectation()); await host.close();
  await assert.rejects(create().start(), /release is unconfirmed/);
});
test("admission across awaits is counted; epoch and operation ABA cannot release", async t => {
  const { host, expectation } = await fixture(t);
  const creating = host.request("thread/start", {}, client); await delay(0);
  const fenced = await host.ownerControl("fence", expectation()); await creating;
  assert.equal(fenced.handoff.epoch, 1);
  await assert.rejects(host.ownerControl("release", { ...expectation(), expectedEpoch: 0 }), /conflict/);
  await assert.rejects(host.ownerControl("release", { ...expectation(), operationId: "other" }), /conflict/);
  await host.ownerControl("release", expectation());
});
test("persistence failure keeps fence; malformed disk never reopens", async t => {
  const { root } = await fixture(t);
  const gate = new AcpHostHandoff(join(root, "missing"), "owner"); await gate.load();
  await assert.rejects(gate.fence({ expectedOwner: "owner", expectedEpoch: 0, operationId: "one", fence: "one" }));
  await assert.rejects(gate.run(async () => true), /fenced/);
  await writeFile(join(root, "host-handoff.json"), '{}');
  await assert.rejects(new AcpHostHandoff(root, "other").load(), /Invalid/);
});
test("native timeout stays unknown occupancy", async t => {
  const transport = new AcpStdioTransport({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), timeoutMs: 20, onNotification() {}, async onRequest() {} });
  t.after(() => transport.close());
  await assert.rejects(transport.start(), /unconfirmed/);
  assert.equal(transport.occupancy.unconfirmedNativeRequests, 1);
});

test("unknown OS authority blocks release, historical bindings never substitute for work count", async t => {
  const root = await mkdtemp(join(tmpdir(), "acp-host-os-"));
  const host = new AcpGenerationHost({ id: "acp", dataDirectory: root, initialGeneration: { id: "a", configPath: "/private/a.json" },
    async readConfig() { return { command: process.execPath, args: [resolve("tests/fixtures/acp-engine-peer.mjs")], cwd: root }; } });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  await host.start();
  const input = { expectedOwner: host.ownerIncarnation, expectedEpoch: 0, operationId: "os", fence: "os" };
  const fenced = await host.ownerControl("fence", input);
  assert.equal(fenced.occupancy.coverage, "unknown"); assert.equal(fenced.occupancy.activeCount, null);
  await assert.rejects(host.ownerControl("release", { ...input, expectedEpoch: 1 }), /not drained/);
});

test("successor crash invalidates a persisted cold readiness receipt", async t => {
  const { host, create, expectation } = await fixture(t);
  await host.ownerControl("fence", expectation()); await host.ownerControl("release", expectation()); await host.close();
  const first = create(); await first.start();
  const ready = await first.ownerControl("cold-ready", expectation(first)); await first.close();
  const next = create(); await next.start();
  await assert.rejects(next.ownerControl("resume", { ...expectation(next), identity: ready.handoff.ready.identity }), /readiness/);
  const fresh = await next.ownerControl("cold-ready", expectation(next));
  await next.ownerControl("resume", { ...expectation(next), identity: fresh.handoff.ready.identity });
});

test("kernel writer ownership rejects a successor before it opens any ACP stores", async t => {
  const { acquireLock } = await import("../../scripts/full-upgrade/durable.mjs");
  const { startIndependentAcpHost } = await import("../../scripts/server-deployment/acp-host.mjs");
  const root = await mkdtemp(join(tmpdir(), "acp-writer-kernel-"));
  const unlock = await acquireLock(join(root, "acp-writer.lock"));
  t.after(async () => { await unlock(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(startIndependentAcpHost({ dataDirectory: root, descriptorPath: join(root, "host.json"), runtimeDirectory: root, initialGeneration: { id: "a", configPath: "/does-not-exist" } }), /command-failed/);
  await assert.rejects(readFile(join(root, "generations.json")), { code: "ENOENT" });
});

for (const code of ["ENOSPC", "EACCES", "EIO"]) test(`durable fence ${code} fails closed before or after rename`, async t => {
  const { open, rename } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "acp-fence-fault-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gate = new AcpHostHandoff(root, "old-owner", { rename,
    open: (async (...args: Parameters<typeof open>) => {
      if (code === "EIO" ? args[0] === root : String(args[0]).endsWith(".tmp")) throw Object.assign(new Error("injected storage fault"), { code });
      return open(...args);
    }) as typeof open });
  await gate.load();
  await assert.rejects(gate.fence({ expectedOwner: "old-owner", expectedEpoch: 0, operationId: "fault", fence: "fault" }), { code });
  await assert.rejects(gate.run(async () => true), /fenced/);
  if (code === "EIO") {
    assert.equal(JSON.parse(await readFile(join(root, "host-handoff.json"), "utf8")).phase, "fenced");
    await assert.rejects(new AcpHostHandoff(root, "new-owner").load(), /release is unconfirmed/);
  }
});

for (const method of ["session/new", "session/prompt"]) test(`native exit during ${method} remains unknown and cannot release`, async t => {
  const { host, expectation, root } = await fixture(t, method);
  if (method === "session/new") await assert.rejects(host.request("thread/start", {}, client));
  else {
    const thread = (await host.request("thread/start", {}, client)).thread.id;
    await host.request("turn/start", { threadId: thread, input: [{ type: "text", text: "once" }] }, client);
  }
  await until(() => host.snapshot().generations[0].occupancy.nativeOutcomeUnknown === 1);
  await host.ownerControl("fence", expectation());
  await assert.rejects(host.ownerControl("release", expectation()), /not drained/);
  await host.close();
  assert.equal(JSON.parse(await readFile(join(root, "generations/a/native-uncertainty.json"), "utf8")).unknown, true);
});

test("successor without native Resume cannot cold ready existing bindings", async t => {
  const { host, create, expectation, peer } = await fixture(t);
  await host.request("thread/start", {}, client);
  await host.ownerControl("fence", expectation()); await host.ownerControl("release", expectation()); await host.close();
  await writeFile(peer, (await readFile(peer, "utf8")).replace('process.env.ACP_TEST_NO_RESUME ? {} : { resume: {} }', '{}'));
  const next = create(); await next.start();
  await assert.rejects(next.ownerControl("cold-ready", expectation(next)), /historical Resume unavailable/);
  assert.equal(next.snapshot().handoff.phase, "released");
});

test("resume rechecks current OS authority and invalidates changed readiness", async t => {
  const { host, create, expectation } = await fixture(t);
  await host.ownerControl("fence", expectation()); await host.ownerControl("release", expectation()); await host.close();
  const next = create(); await next.start();
  const ready = await next.ownerControl("cold-ready", expectation(next));
  const options = (next as any).options;
  options.inspectOsWork = () => ({ coverage: "unknown", activeCount: null });
  await assert.rejects(next.ownerControl("resume", { ...expectation(next), identity: ready.handoff.ready.identity }), /readiness/);
  options.inspectOsWork = () => ({ coverage: "complete", activeCount: 1 });
  await assert.rejects(next.ownerControl("resume", { ...expectation(next), identity: ready.handoff.ready.identity }), /readiness/);
  assert.equal(next.snapshot().handoff.phase, "cold-ready");
});

test("real Host WebSocket resource calls share the fence and in-flight drain authority", async t => {
  const { host, root, expectation } = await fixture(t);
  const { startEngineHost } = await import("../../apps/local-agent-host/src/engine-host.js");
  const { WebSocket } = await import("ws");
  const { execFileSync } = await import("node:child_process");
  const server = await startEngineHost({ providers: [host], defaultEngine: "acp", resources: { projectDirectory: join(root, "projects") },
    admitRequest: (method, run) => host.admitHostRequest(method, run), strictClose: true });
  const socket = new WebSocket(server.websocketUrl), pending = new Map<number, any>(); let sequence = 0;
  socket.on("message", bytes => { const f = JSON.parse(String(bytes)), p = pending.get(f.id); if (!p || f.method) return; pending.delete(f.id); f.error ? p.reject(new Error(f.error.message)) : p.resolve(f.result); });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  t.after(async () => { socket.terminate(); await server.close(); });
  const request = (method: string, params: any) => new Promise<any>((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
  const fifo = join(root, "held-read"); execFileSync("/usr/bin/mkfifo", [fifo]);
  const reading = request("fs/readFile", { path: fifo });
  await until(() => host.snapshot().handoff.activeCalls > 0);
  const fenced = await host.ownerControl("fence", expectation());
  assert.ok(fenced.occupancy.activeCount > 0);
  await assert.rejects(host.ownerControl("release", expectation()), /not drained/);
  await assert.rejects(request("fs/writeFile", { path: join(root, "must-not-exist"), dataBase64: "eA==" }), /fenced/);
  await assert.rejects(request("project/create", { directory: root }), /fenced/);
  await writeFile(fifo, "released"); assert.equal(Buffer.from((await reading).dataBase64, "base64").toString(), "released");
  await host.ownerControl("release", expectation());
  await assert.rejects(request("fs/writeFile", { path: join(root, "must-not-exist"), dataBase64: "eA==" }), /fenced/);
  await assert.rejects(readFile(join(root, "must-not-exist")), { code: "ENOENT" });
});
