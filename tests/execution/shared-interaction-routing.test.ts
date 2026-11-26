import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexCoreBridge } from "../../apps/opencraft-daemon/src/codex-core-bridge";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { SHARED_INTERACTIONS_EXTENSION, SHARED_INTERACTIONS_CHANGED, SHARED_INTERACTIONS_RESPOND, SHARED_INTERACTIONS_READ } from "@opencraft/appserver-protocol";

const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | undefined): Promise<T> {
  for (let n = 0; n < 500; n++) { const value = read(); if (value !== undefined) return value; await delay(); }
  throw Error("Timed out waiting for shared interaction");
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "oc-shared-interaction-")), frames: any[] = [];
  const adapter = new CodexEngineAdapter({ executable: process.execPath, runtimeDirectory: root, dataDirectory: join(root, "data"),
    nativeCodexHomeDirectory: join(root, "native"), upstreamBaseUrl: "http://127.0.0.1:9/backend-api/codex",
    fetch: async () => Response.json({ ok: true }), createMaintenanceClient: async () => { throw Error("unused"); },
    spawnAppServer: ({ cwd, env }) => spawn(process.execPath, [new URL("../fixtures/fake-codex-stdio-appserver.mjs", import.meta.url).pathname], { cwd, env, stdio: ["pipe", "pipe", "pipe"] }), logDiagnostic() {} });
  adapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  t.after(async () => { await adapter.close(); await rm(root, { recursive: true, force: true }); });
  await adapter.connect(); let sequence = 0;
  const rpc = async (client: string, method: string, params: unknown = {}) => {
    const id = `rpc-${++sequence}`; await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }));
    return until(() => frames.find(f => f.id === id));
  };
  const init = (client: string, shared = true) => rpc(client, "initialize", { capabilities: { extensions: shared ? { [SHARED_INTERACTIONS_EXTENSION]: { version: 1 } } : {} } });
  const snapshot = (client: string) => frames.filter(f => f[LOGICAL_CLIENT_FIELD] === client && f.method === SHARED_INTERACTIONS_CHANGED).at(-1)?.params;
  const emit = (id = 901, method = "item/commandExecution/requestApproval") => (adapter as any).receiveServerRequest(id, { id, method, params: { threadId: "fixture-thread-1", turnId: "turn", itemId: `item-${id}`, command: "echo fixture", questions: [] } });
  return { root, adapter, frames, rpc, init, snapshot, emit };
}

test("all subscribed clients, late readers and legacy viewers see human waits without executable callback fanout", async t => {
  const f = await fixture(t); await f.init("a"); await f.init("b"); await f.init("unrelated");
  await f.rpc("a", "thread/start", { cwd: f.root, testNoServerRequest: true });
  await f.rpc("b", "thread/resume", { threadId: "fixture-thread-1" });
  for (const [i, method] of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request"].entries()) f.emit(901 + i, method);
  assert.equal(f.snapshot("a").requests.length, 5); assert.equal(f.snapshot("b").requests.length, 5);
  assert.equal(f.snapshot("unrelated"), undefined);
  assert.equal(f.frames.some(frame => frame.id === 901 && frame.method), false, "passive clients do not execute raw RPC handlers");
  await f.init("late"); await f.rpc("late", "thread/read", { threadId: "fixture-thread-1", includeTurns: false, watch: true });
  assert.equal(f.snapshot("late").requests.length, 5);
  await f.init("legacy", false); await f.rpc("legacy", "thread/resume", { threadId: "fixture-thread-1" });
  assert.equal(f.frames.filter(frame => frame[LOGICAL_CLIENT_FIELD] === "legacy" && frame.method?.endsWith("requestApproval")).length, 3);
  f.emit(999, "item/tool/call");
  assert.equal(f.frames.filter(frame => frame.id === 999 && frame.method === "item/tool/call").length, 1, "executable tool has exactly one owner");
  assert.equal((await f.rpc("unrelated", SHARED_INTERACTIONS_READ, { threadId: "fixture-thread-1" })).error.code, 403);
  await f.adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "a" }));
  const request = f.snapshot("b").requests[0];
  const answers = await Promise.all([f.rpc("b", SHARED_INTERACTIONS_RESPOND, { threadId: "fixture-thread-1", interactionId: request.id, submissionId: "answer-b", result: { decision: "accept" } }),
    f.rpc("late", SHARED_INTERACTIONS_RESPOND, { threadId: "fixture-thread-1", interactionId: request.id, submissionId: "answer-late", result: { decision: "decline" } })]);
  assert.ok(answers.every(a => !a.error));
  await until(() => f.snapshot("b")?.requests.length === 4 ? true : undefined);
  assert.equal(f.snapshot("late").requests.length, 4);
  assert.equal(f.frames.filter(frame => frame.method === "serverRequest/resolved" && frame.params.requestId === 901 && frame[LOGICAL_CLIENT_FIELD] === "b").length, 1);
});

for (const shared of [true, false]) {
  test(`native approval releases a revoked submitter before delivery (shared=${shared})`, async t => {
    const f = await fixture(t);
    await f.init("a", shared);
    await f.init("b");
    const threadId = "fixture-thread-1";
    await f.rpc("a", "thread/start", { cwd: f.root, testNoServerRequest: true });
    await f.rpc("b", "thread/resume", { threadId });

    let current = true;
    f.adapter.subscribeMessage(raw => {
      const frame = JSON.parse(raw);
      if (frame[LOGICAL_CLIENT_FIELD] === "b" && frame.method === SHARED_INTERACTIONS_CHANGED &&
          frame.params.requests[0]?.state === "responding") current = false;
    });
    f.emit();
    const interactionId = f.snapshot("b").requests[0].id;
    const legacy = f.frames.find(frame => frame.method === "item/commandExecution/requestApproval" && frame[LOGICAL_CLIENT_FIELD] === "a");
    if (!shared) assert.ok(legacy);
    const answer = { decision: "decline" };
    const submission = shared
      ? { id: "first-answer", method: SHARED_INTERACTIONS_RESPOND, params: { threadId, interactionId, submissionId: "first", result: answer } }
      : { id: legacy.id, result: answer };
    const submitted = f.adapter.sendWithContext(JSON.stringify({ ...submission, [LOGICAL_CLIENT_FIELD]: "a" }), {
      sender: null,
      resourceOwner: { id: "fixture-owner", assertCurrent() { if (!current) throw Error("Expired owner"); } },
    });
    if (shared) {
      await submitted;
      const refusal = await until(() => f.frames.find(frame => frame.id === "first-answer"));
      assert.equal(refusal.error.data?.submissionOutcome, "rejected");
    } else {
      await assert.rejects(submitted, /subscription expired/);
    }
    assert.equal(current, false);
    assert.equal(f.snapshot("b").requests[0]?.state, "pending");

    const peer = await f.rpc("b", SHARED_INTERACTIONS_RESPOND, {
      threadId, interactionId, submissionId: "peer", result: { decision: "accept" },
    });
    assert.equal(peer.result?.disposition, "submitted");
    await until(() => f.snapshot("b").requests.length === 0 ? true : undefined);
    assert.equal(f.frames.filter(frame => frame.method === "serverRequest/resolved" &&
      frame.params.requestId === 901 && frame[LOGICAL_CLIENT_FIELD] === "b").length, 1);
  });
}

for (const shared of [true, false]) {
  test(`split Codex Core releases a revoked submitter before delivery (shared=${shared})`, async t => {
    const bridge = new CodexCoreBridge("/fixture-unused", "fixture-token");
    t.after(() => bridge.close());
    const native = bridge as any;
    const nativeResponses: unknown[] = [], frames: any[] = [];
    const threadId = "fixture-thread-1";
    native.connection.value = { state: "open" };
    native.connection.send = (raw: string) => {
      const frame = JSON.parse(raw);
      if (frame.method === "initialize" || frame.method === "thread/resume") {
        native.receive(JSON.stringify({ id: frame.id, result: frame.method === "initialize"
          ? { capabilities: {} } : { thread: { id: threadId } } }));
      } else if (frame.id === 901) {
        nativeResponses.push(frame.result);
      }
    };
    let current = true;
    const resourceOwner = { id: "fixture-owner", assertCurrent() { if (!current) throw Error("Expired owner"); } };
    bridge.subscribeMessage(raw => {
      const frame = JSON.parse(raw);
      frames.push(frame);
      if (frame[LOGICAL_CLIENT_FIELD] === "b" && frame.method === SHARED_INTERACTIONS_CHANGED &&
          frame.params.requests[0]?.state === "responding") current = false;
    });
    const send = (client: string, message: Record<string, unknown>, owner?: typeof resourceOwner) =>
      bridge.sendWithContext(JSON.stringify({ ...message, [LOGICAL_CLIENT_FIELD]: client }), { sender: null, resourceOwner: owner });
    for (const client of ["a", "b"]) {
      const extensions = shared || client === "b" ? { [SHARED_INTERACTIONS_EXTENSION]: { version: 1 } } : {};
      await send(client, { id: "init", method: "initialize", params: { capabilities: { extensions } } });
      await send(client, { id: "resume", method: "thread/resume", params: { threadId } });
    }
    native.receive(JSON.stringify({ id: 901, method: "item/commandExecution/requestApproval",
      params: { threadId, turnId: "turn", itemId: "item", command: "echo fixture" } }));
    const snapshot = () => frames.filter(frame => frame[LOGICAL_CLIENT_FIELD] === "b" && frame.method === SHARED_INTERACTIONS_CHANGED).at(-1).params;
    const interactionId = snapshot().requests[0].id;
    const legacy = frames.find(frame => frame.method === "item/commandExecution/requestApproval" && frame[LOGICAL_CLIENT_FIELD] === "a");
    if (!shared) assert.ok(legacy);
    const result = { decision: "decline" };
    const submission = shared
      ? { id: "first", method: SHARED_INTERACTIONS_RESPOND, params: { threadId, interactionId, submissionId: "first", result } }
      : { id: legacy.id, result };
    const submitted = send("a", submission, resourceOwner);
    if (shared) {
      await submitted;
      assert.equal(frames.find(frame => frame.id === "first")?.error?.data?.submissionOutcome, "rejected");
    } else {
      await assert.rejects(submitted, /subscription expired/);
    }
    assert.equal(current, false);
    assert.equal(snapshot().requests[0]?.state, "pending");
    assert.deepEqual(nativeResponses, []);

    await send("b", { id: "peer", method: SHARED_INTERACTIONS_RESPOND, params: {
      threadId, interactionId, submissionId: "peer", result: { decision: "accept" },
    } });
    assert.equal(frames.find(frame => frame.id === "peer")?.result?.disposition, "submitted");
    assert.deepEqual(nativeResponses, [{ decision: "accept" }]);
    if (!shared) {
      native.receive(JSON.stringify({ method: "serverRequest/resolved", params: { threadId, requestId: 901 } }));
      assert.ok(frames.some(frame => frame.method === "serverRequest/resolved" &&
        frame[LOGICAL_CLIENT_FIELD] === "a" && frame.params.requestId === legacy.id));
      native.receive(JSON.stringify({ id: 901, method: "item/commandExecution/requestApproval",
        params: { threadId, turnId: "new-turn", itemId: "new-item", command: "echo fixture" } }));
      const fresh = frames.filter(frame => frame.method === "item/commandExecution/requestApproval" &&
        frame[LOGICAL_CLIENT_FIELD] === "a").at(-1);
      assert.notEqual(fresh.id, legacy.id);
      await send("a", { id: legacy.id, result: { decision: "accept" } });
      assert.deepEqual(nativeResponses, [{ decision: "accept" }]);
      native.receive(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: "new-turn", status: "completed" } } }));
      assert.ok(frames.some(frame => frame.method === "serverRequest/resolved" &&
        frame[LOGICAL_CLIENT_FIELD] === "a" && frame.params.requestId === fresh.id));
      await send("a", { id: fresh.id, result: { decision: "decline" } });
      assert.deepEqual(nativeResponses, [{ decision: "accept" }]);
    }
  });
}

test("a pre-write response failure preserves a shared unconfirmed wait", async t => {
  const f = await fixture(t); await f.init("a"); await f.init("b");
  await f.rpc("a", "thread/start", { cwd: f.root, testNoServerRequest: true }); await f.rpc("b", "thread/resume", { threadId: "fixture-thread-1" });
  f.emit(); const request = f.snapshot("a").requests[0], native = f.adapter as any, original = native.writePhysical.bind(native);
  native.writePhysical = async (message: any, ...args: any[]) => { if (message.id === 901 && message.result) throw Error("fixture pre-write failure"); return original(message, ...args); };
  const response = await f.rpc("a", SHARED_INTERACTIONS_RESPOND, { threadId: "fixture-thread-1", interactionId: request.id, submissionId: "answer", result: { decision: "accept" } });
  assert.ok(response.error); assert.equal(f.snapshot("b").requests[0].state, "unconfirmed");
  native.writePhysical = original;
  await f.rpc("b", "thread/resume", { threadId: "fixture-thread-1" });
  assert.equal(f.snapshot("b").requests[0].state, "unconfirmed");
});

test("native failure disables every shared source until an actual request replay", async t => {
  const f = await fixture(t); await f.init("a"); await f.rpc("a", "thread/start", { cwd: f.root, testNoServerRequest: true });
  f.emit(); const request = f.snapshot("a").requests[0];
  (f.adapter as any).publishStatus({ state: "failed" });
  assert.equal(f.snapshot("a").requests[0].canRespond, false);
  (f.adapter as any).publishStatus({ state: "open" });
  const reply = await f.rpc("a", SHARED_INTERACTIONS_RESPOND, { threadId: "fixture-thread-1", interactionId: request.id, submissionId: "stale", result: { decision: "accept" } });
  assert.equal(reply.error.code, -32083); assert.equal(f.snapshot("a").requests[0].canRespond, false);
  f.emit(); assert.equal(f.snapshot("a").requests[0].id, request.id); assert.equal(f.snapshot("a").requests[0].canRespond, true);
});

test('adapter sends the stable approval identity after a reused native route reconnects', async t => {
  const f=await fixture(t);await f.init('a');await f.rpc('a','thread/start',{cwd:f.root,testNoServerRequest:true});
  const native=f.adapter as any;
  const emit=(key:string,turnId:string)=>native.receiveServerRequest(901,{id:901,method:'item/commandExecution/requestApproval',__opencraftInteractionKey:key,params:{threadId:'fixture-thread-1',turnId,itemId:'item',command:'echo fixture'}});
  emit('old','old-turn');native.publishStatus({state:'failed'});native.publishStatus({state:'open'});emit('fresh','new-turn');
  const writes:any[]=[];
  const original=native.writePhysical.bind(native);
  native.writePhysical=async(message:any,...args:any[])=>{if(message.id===901&&message.result){writes.push(message);return;}return original(message,...args);};
  const old=await f.rpc('a',SHARED_INTERACTIONS_RESPOND,{threadId:'fixture-thread-1',interactionId:'old',submissionId:'old',result:{decision:'accept'}});
  assert.equal(old.error.code,-32083);
  const fresh=await f.rpc('a',SHARED_INTERACTIONS_RESPOND,{threadId:'fixture-thread-1',interactionId:'fresh',submissionId:'fresh',result:{decision:'decline'}});
  assert.equal(fresh.error,undefined);
  assert.deepEqual(writes,[{id:901,result:{decision:'decline'},__opencraftInteractionKey:'fresh'}]);
});

test("a legacy Codex reply cannot answer a newer approval that reused its native request ID", async t => {
  const f = await fixture(t);
  await f.init("legacy", false);
  await f.init("peer");
  const threadId = "fixture-thread-1";
  await f.rpc("legacy", "thread/start", { cwd: f.root, testNoServerRequest: true });
  await f.rpc("peer", "thread/resume", { threadId });
  const native = f.adapter as any;
  const writes: unknown[] = [];
  const write = native.writePhysical.bind(native);
  native.writePhysical = (message: any, ...args: unknown[]) => {
    if (message.id === 901 && message.result) writes.push(message.result);
    return write(message, ...args);
  };
  const offers = () => f.frames.filter(frame => frame[LOGICAL_CLIENT_FIELD] === "legacy" &&
    frame.method === "item/commandExecution/requestApproval");
  const answer = (id: string | number, decision: string) =>
    f.adapter.send(JSON.stringify({ id, result: { decision }, [LOGICAL_CLIENT_FIELD]: "legacy" }));

  f.emit();
  const firstId = offers()[0].id;
  await answer(firstId, "accept");
  await until(() => f.frames.find(frame => frame[LOGICAL_CLIENT_FIELD] === "legacy" &&
    frame.method === "serverRequest/resolved" && frame.params.requestId === firstId));
  assert.deepEqual(writes, [{ decision: "accept" }]);

  f.emit();
  const secondId = offers()[1].id;
  await answer(firstId, "accept");
  assert.deepEqual(writes, [{ decision: "accept" }]);
  assert.notEqual(secondId, firstId);
  assert.equal(f.snapshot("peer").requests[0].state, "pending");
  await answer(secondId, "decline");
  await until(() => f.frames.find(frame => frame[LOGICAL_CLIENT_FIELD] === "legacy" &&
    frame.method === "serverRequest/resolved" && frame.params.requestId === secondId));
  assert.deepEqual(writes, [{ decision: "accept" }, { decision: "decline" }]);
});
