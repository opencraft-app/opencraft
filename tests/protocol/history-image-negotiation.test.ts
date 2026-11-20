import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { createCordisThreadSessionRuntime } from "@opencraft/appserver-session";
import { readTurnsPage } from "../../packages/appserver-session/src/history-strategies.js";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";

for (const supported of [true, false]) test(`image resources require explicit host capability: ${supported}`, async () => {
  const calls: { method: string; params: any }[] = [];
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
    calls.push({ method: request.method, params: request.params });
    const send = (result: unknown) => peer.send(encodeJsonRpcMessage({ id: request.id, result }));
    if (request.method === "initialize") { send({ codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "resource-test",
      capabilities: { extensions: { "opencraft/read-history": { version: 1, itemDetails: true, ...(supported ? { imageResources: true } : {}) } } } }); return; }
    if (request.method === "thread/turns/list") { send({ data: [], nextCursor: null }); return; }
    send({ thread: { id: "t", sessionId: "t", cwd: "/workspace", path: "/rollout", historyMode: "paginated", turns: [] },
      initialTurnsPage: { data: [], nextCursor: null } });
  } });
  const client = new JsonRpcAppServerClient({ hostId: "image-test", transport });
  await client.connect({ clientInfo: { name: "image-test", version: "1" }, capabilities: {} });
  const session = await createCordisThreadSessionRuntime({ client, drainTailHistory: false });
  try {
    await session.resume.read("t");
    await readTurnsPage({ client, threadId: "t", requestTimeoutMs: 1000 }, "cursor", 10);
    const read = calls.find(c=>c.method==="thread/read")!.params.initialTurnsPage;
    assert.equal(read.imageResources,supported?true:undefined);
    assert.equal(read.itemsView,"presentation"); assert.equal(read.limit,1);
    const page = calls.find(c=>c.method==="thread/turns/list")!.params;
    assert.equal(page.imageResources,supported?true:undefined);
    assert.equal(page.cursor,"cursor"); assert.equal(page.limit,10); assert.equal(page.sortDirection,"desc");
    assert.ok(!calls.some(c=>c.method==="thread/resume" || c.method==="turn/start"));
  } finally { await session.dispose(); await client.close(); }
});
