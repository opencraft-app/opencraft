import assert from "node:assert/strict";
import test from "node:test";
import { AppServerClientError, JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { createAppServerConversationCommandPort } from "@opencraft/composer-appserver";
import { SubmissionNotDispatchedError, SubmissionOutcomeUnknownError } from "@opencraft/chat-runtime";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
import { intent } from "../fixtures/workbench-draft-harness";
async function fixture(closeAfterCreate = false) {
  const methods: string[] = [];
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
    methods.push(request.method); const send = (result: unknown) => peer.send(encodeJsonRpcMessage({ id: request.id, result }));
    if (request.method === "initialize") send({ codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "admission" });
    else if (request.method === "thread/start") { send({ thread: { id: "created" } }); if (closeAfterCreate) void transport.close(); }
    else if (request.method === "turn/start") send({ turn: { id: "turn-created" } });
    else send({});
  } });
  const client = new JsonRpcAppServerClient({ hostId: "admission", transport });
  await client.connect({ clientInfo: { name: "admission", version: "1" }, capabilities: {} });
  return { client, methods, close: () => client.close() };
}
test("client admission preserves the exact local error and sends no rejected frame", async () => {
  const f = await fixture(), policy = new Error("local admission retired");
  try {
    await assert.rejects(f.client.request("thread/read", { threadId: "a", includeTurns: false }, { beforeSend() { throw policy; } }), error => error === policy);
    assert.equal(f.methods.filter(method => method === "thread/read").length, 0);
    await f.client.request("thread/read", { threadId: "b", includeTurns: false }); assert.equal(f.methods.filter(method => method === "thread/read").length, 1);
  } finally { await f.close(); }
});
test("the final admission check follows serialization side effects", async () => {
  const f = await fixture(); let allowed = true;
  try {
    await assert.rejects(f.client.request("thread/read", { get threadId() { allowed = false; return "a"; }, includeTurns: false }, { beforeSend() { if (!allowed) throw new Error("retired during serialization"); } }), /retired during serialization/);
    assert.equal(f.methods.filter(method => method === "thread/read").length, 0);
  } finally { await f.close(); }
});
test("admission reentry that aborts its request cannot allocate a wire frame", async () => {
  const f = await fixture(), controller = new AbortController();
  try {
    await assert.rejects(f.client.request("thread/read", { threadId: "a", includeTurns: false }, { signal: controller.signal, beforeSend() { controller.abort(); } }), error => (error as { code?: string }).code === "ABORTED");
    assert.equal(f.methods.filter(method => method === "thread/read").length, 0);
  } finally { await f.close(); }
});
for (const afterCreate of [false, true]) test(`submission admission classification accounts for prior creation=${afterCreate}`, async () => {
  const f = await fixture(afterCreate), port = createAppServerConversationCommandPort({ hostId: "admission", client: f.client });
  const user = intent({ type: "new-thread", draftId: "draft", execution: { hostId: "admission", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] } } });
  try {
    await assert.rejects(port.submit(user, { canDispatch: () => afterCreate }), error => afterCreate
      ? error instanceof SubmissionOutcomeUnknownError && !(error instanceof SubmissionNotDispatchedError)
      : error instanceof SubmissionNotDispatchedError);
    assert.equal(f.methods.filter(method => method === "thread/start").length, afterCreate ? 1 : 0);
    assert.equal(f.methods.filter(method => method === "turn/start").length, 0);
  } finally { await f.close(); }
});

test("a subsequent NOT_CONNECTED after a creation ACK is never classified wholly unsent", async () => {
  const f = await fixture(), request = f.client.request.bind(f.client);
  f.client.request = ((method, params, options) => method === "turn/start"
    ? Promise.reject(new AppServerClientError("NOT_CONNECTED", "fixture connection lost after creation"))
    : request(method, params, options)) as typeof f.client.request;
  const port = createAppServerConversationCommandPort({ hostId: "admission", client: f.client });
  const user = intent({ type: "new-thread", draftId: "draft", execution: { hostId: "admission", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] } } });
  try {
    await assert.rejects(port.submit(user, { canDispatch: () => true }), error => error instanceof SubmissionOutcomeUnknownError);
    assert.equal(f.methods.filter(method => method === "thread/start").length, 1);
    assert.equal(f.methods.filter(method => method === "turn/start").length, 0);
  } finally { await f.close(); }
});
