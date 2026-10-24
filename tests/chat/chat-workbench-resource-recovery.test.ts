import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const thread = (id: string) => ({ id, sessionId: id, name: id, cwd: "/workspace", path: `/rollouts/${id}`, historyMode: "paginated", status: { type: "idle" }, turns: [] });

test("Host and active Thread recover independently of a rejected Thread and stalled watch", async () => {
  let peer!: InMemoryAppServerPeer;
  let recovering = false;
  const requests: string[] = [];
  const resumedIds: string[] = [];
  const transport = new MemoryTransport({
    connected(value) { peer = value; },
    receive(frame, reply) {
      const message = JSON.parse(frame);
      if (message.id === undefined) return;
      requests.push(message.method);
      const send = (result: unknown) => reply.send(JSON.stringify({ id: message.id, result }));
      if (message.method === "initialize") send({ codexHome: "/tmp", platformFamily: "unix", platformOs: "linux", userAgent: "recovery-test" });
      else if (message.method === "thread/read") send({ thread: thread(message.params.threadId) });
      else if (message.method === "thread/resume") {
        resumedIds.push(message.params.threadId);
        if (recovering && message.params.threadId === "missing") {
          reply.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Thread no longer exists" } }));
        } else send({ thread: thread(message.params.threadId), model: "test", modelProvider: "test", cwd: "/workspace",
          serviceTier: "fast", reasoningEffort: "medium", approvalsReviewer: "user",
          runtimeWorkspaceRoots: ["/workspace"], instructionSources: [], activePermissionProfile: { id: "workspace" },
          approvalPolicy: "on-request", sandbox: { type: "workspaceWrite", writableRoots: ["/workspace"] },
          initialTurnsPage: { data: [], nextCursor: null }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
      } else if (message.method === "fs/watch" && recovering) return;
      else if (message.method.endsWith("/list")) send({ data: [], nextCursor: null });
      else send({});
    },
  });
  const runtime = createAppServerWorkbenchRuntime({ hostId: "recovery", transport, autoReconnect: false, requestTimeoutMs: 100 });
  try {
    await runtime.connect();
    const missing = await runtime.acquireThread("missing");
    const healthy = await runtime.acquireThread("healthy");
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(healthy.getSnapshot().authoritative, true, healthy.getSnapshot().error?.message);
    healthy.setRecoveryVisibility(true);
    const cached = await runtime.acquireThread("cache-only");
    for (let i = 0; i < 10; i++) await tick();
    cached.release();
    const recoveryStart = resumedIds.length;
    // Existing watcher restoration must not delay current chat readiness.
    await runtime.resources.fileSystem.watch("/workspace", () => undefined);
    recovering = true; peer.close("network lost");
    await runtime.reconnect();
    assert.equal(runtime.getSnapshot().phase, "ready");
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(healthy.getSnapshot().authoritative, true);
    assert.equal(healthy.getSnapshot().execution.serviceTier, "fast", "reconnect restores speed from the Host");
    assert.equal(runtime.getThreadResidency("missing")?.phase, "error");
    assert.deepEqual(resumedIds.slice(recoveryStart), ["healthy", "missing"], "visible first; cache residency alone creates no recovery read");
    const reopened = await runtime.acquireThread("cache-only");
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(reopened.getSnapshot().authoritative, true);
    assert.equal(resumedIds.at(-1), "cache-only");
    reopened.release();
    assert.equal(runtime.getSnapshot().phase, "ready");
    assert.equal(requests.filter(method => method === "initialize").length, 2);
    assert.equal(requests.includes("turn/start"), false);
    missing.release(); healthy.release();
  } finally { await runtime.dispose(); }
});

for (const mode of ["acquire", "retry"] as const) {
  test(`${mode}: a history timeout recovers automatically while Host stays ready`, async () => {
    let drop = mode === "acquire", resumes = 0, initializes = 0;
    const methods: string[] = [];
    const transport = new MemoryTransport({ receive(frame, peer) {
      const request = JSON.parse(frame); if (request.id === undefined) return;
      methods.push(request.method);
      const send = (result: unknown) => peer.send(JSON.stringify({id:request.id,result}));
      if (request.method === "initialize") { initializes++;send({codexHome:"/tmp",platformFamily:"unix",platformOs:"linux",userAgent:"timeout-test"}); }
      else if (request.method === "thread/read") send({thread:thread("history")});
      else if (request.method === "thread/resume") {
        resumes++; if (drop) { drop=false;return; }
        send({thread:thread("history"),model:"test",modelProvider:"test",cwd:"/workspace",serviceTier:"default",
          reasoningEffort:"medium",approvalsReviewer:"user",runtimeWorkspaceRoots:["/workspace"],instructionSources:[],
          activePermissionProfile:{id:"workspace"},approvalPolicy:"on-request",sandbox:{type:"workspaceWrite",writableRoots:["/workspace"]},
          initialTurnsPage:{data:[],nextCursor:null},turnsBackwardsCursor:null,itemsBackwardsCursor:null});
      } else if (request.method.endsWith("/list")) send({data:[],nextCursor:null});
      else send({});
    }});
    const runtime=createAppServerWorkbenchRuntime({hostId:`timeout-${mode}`,transport,autoReconnect:false,
      requestTimeoutMs:25,reconnectDelaysMs:[5,10]});
    try {
      await runtime.connect(); const lease=await runtime.acquireThread("history");lease.setRecoveryVisibility(true);
      const waitReady=async()=>{
        for(let i=0;i<100&&!lease.getSnapshot().authoritative;i++) await new Promise(resolve=>setTimeout(resolve,5));
        assert.equal(lease.getSnapshot().authoritative,true,lease.getSnapshot().error?.message);
      };
      await waitReady();
      if(mode==="retry") { drop=true;await lease.retryRestore(); }
      assert.equal(resumes,mode==="acquire"?2:3);
      assert.equal(lease.getSnapshot().authoritative,true);
      assert.equal(lease.getSnapshot().error,null);
      assert.equal(runtime.getSnapshot().phase,"ready");assert.equal(initializes,1);
      assert.equal(methods.some(method=>["turn/start","turn/steer","thread/start"].includes(method)),false);
      lease.release();
    } finally { await runtime.dispose(); }
  });
}

for (const [label, data, persistent, expected] of [
  ["transient", { retryable: true }, false, 2],
  ["permanent", { retryable: false }, false, 1],
  ["unknown", undefined, false, 1],
  ["malformed", { retryable: "true" }, false, 1],
  ["persistent transient", { retryable: true }, true, 4],
] as const) {
  test(`${label}: RPC history recovery respects explicit retryability and the existing bound`, async () => {
    let resumes = 0, initializes = 0;
    const methods: string[] = [];
    const transport = new MemoryTransport({ receive(frame, peer) {
      const request = JSON.parse(frame); if (request.id === undefined) return;
      methods.push(request.method);
      const send = (result: unknown) => peer.send(JSON.stringify({ id: request.id, result }));
      if (request.method === "initialize") { initializes++; send({ codexHome: "/tmp", platformFamily: "unix", platformOs: "linux", userAgent: "rpc-recovery-test" }); }
      else if (request.method === "thread/read") send({ thread: thread("history") });
      else if (request.method === "thread/resume") {
        resumes++;
        if (persistent || resumes === 1) {
          peer.send(JSON.stringify({ id: request.id, error: { code: -32000, message: "history unavailable", data } }));
        } else send({ thread: thread("history"), model: "test", modelProvider: "test", cwd: "/workspace",
          approvalPolicy: "on-request", approvalsReviewer: "user", runtimeWorkspaceRoots: ["/workspace"],
          sandbox: { type: "workspaceWrite", writableRoots: ["/workspace"] },
          initialTurnsPage: { data: [], nextCursor: null }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
      } else if (request.method.endsWith("/list")) send({ data: [], nextCursor: null });
      else send({});
    }});
    const runtime = createAppServerWorkbenchRuntime({ hostId: `rpc-${label}`, transport, autoReconnect: false,
      requestTimeoutMs: 100, reconnectDelaysMs: [5, 10, 20] });
    try {
      await runtime.connect();
      const lease = await runtime.acquireThread("history");
      const deadline = Date.now() + 1000;
      while (resumes < expected || (expected === 2 && !lease.getSnapshot().authoritative)) {
        assert.ok(Date.now() < deadline, "recovery must reach its expected outcome");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(resumes, expected);
      assert.equal(lease.getSnapshot().authoritative, expected === 2);
      assert.equal(runtime.getSnapshot().phase, "ready");
      assert.equal(initializes, 1, "Thread failures must not reconnect the Host");
      assert.equal(methods.some(method => ["turn/start", "turn/steer", "thread/start"].includes(method)), false);
      lease.release();
    } finally { await runtime.dispose(); }
  });
}

test("making a cold Thread visible does not resume a healthy peer; connection loss still restores both", async () => {
  let peer!: InMemoryAppServerPeer;
  let completeCold: (() => void) | undefined;
  const resumes: string[] = [];
  let watchRequests = 0;
  const transport = new MemoryTransport({
    connected(value) { peer = value; },
    receive(frame, reply) {
      const request = JSON.parse(frame);
      if (request.id === undefined) return;
      const send = (result: unknown) => reply.send(JSON.stringify({ id: request.id, result }));
      if (request.method === "initialize") send({ codexHome: "/tmp", platformFamily: "unix", platformOs: "linux", userAgent: "visibility-test" });
      else if (request.method === "thread/read") send({ thread: thread(request.params.threadId) });
      else if (request.method === "thread/resume") {
        const id = request.params.threadId;
        resumes.push(id);
        const finish = () => send({ thread: thread(id), model: "test", modelProvider: "test", cwd: "/workspace",
          approvalsReviewer: "user", runtimeWorkspaceRoots: ["/workspace"], instructionSources: [],
          approvalPolicy: "on-request", sandbox: { type: "workspaceWrite", writableRoots: ["/workspace"] },
          initialTurnsPage: { data: [], nextCursor: null }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
        if (id === "cold" && resumes.filter(value => value === id).length === 1) completeCold = finish;
        else finish();
      } else if (request.method === "fs/watch") { watchRequests++; send({}); }
      else if (request.method.endsWith("/list")) send({ data: [], nextCursor: null });
      else send({});
    },
  });
  const runtime = createAppServerWorkbenchRuntime({ hostId: "visibility", transport, autoReconnect: false });
  const settle = async (check: () => boolean) => {
    for (let i = 0; i < 100; i++) { if (check()) return; await tick(); }
    assert.fail("Thread recovery did not settle");
  };
  try {
    await runtime.connect();
    const healthy = await runtime.acquireThread("healthy");
    healthy.setRecoveryVisibility(true);
    await settle(() => healthy.getSnapshot().authoritative);
    await runtime.resources.fileSystem.watch("/workspace", () => undefined);
    const cold = await runtime.acquireThread("cold");
    await settle(() => completeCold !== undefined);
    healthy.setRecoveryVisibility(false);
    cold.setRecoveryVisibility(true);
    cold.setRecoveryVisibility(true);
    for (let i = 0; i < 10; i++) await tick();
    assert.deepEqual(resumes, ["healthy", "cold"], "navigation must not force-resume the retained healthy peer");
    assert.equal(watchRequests, 1, "navigation must not restore unrelated Host watches");
    assert.equal(healthy.getSnapshot().authoritative, true);
    completeCold!();
    await settle(() => cold.getSnapshot().authoritative);
    peer.close("synthetic connection loss");
    await runtime.reconnect();
    await settle(() => healthy.getSnapshot().authoritative && cold.getSnapshot().authoritative);
    assert.deepEqual(resumes, ["healthy", "cold", "cold", "healthy"], "real reconnect restores visible then retained open Thread");
    assert.equal(watchRequests, 2);
    await healthy.release(); await cold.release();
  } finally { await runtime.dispose(); }
});
