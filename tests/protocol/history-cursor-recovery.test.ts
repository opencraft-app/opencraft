import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { readTurnsPage } from "@opencraft/appserver-session";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";

for (const kind of ["generic", "repeated", "aborted"] as const) test(`older history cursor recovery is explicit and bounded: ${kind}`, async () => {
  const cursors: unknown[] = [], controller = new AbortController();
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
    if (request.method === "initialize") {
      peer.send(encodeJsonRpcMessage({ id: request.id, result: { codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "cursor-recovery" } })); return;
    }
    cursors.push((request.params as { cursor: unknown }).cursor);
    if (kind === "aborted") controller.abort();
    peer.send(encodeJsonRpcMessage({ id: request.id, error: { code: -32602, message: "History cursor unavailable",
      ...(kind === "generic" ? {} : { data: { code: "HISTORY_CURSOR_EXPIRED", retryable: true, replacementCursor: `fresh-${cursors.length}` } }),
    } }));
  } });
  const client = new JsonRpcAppServerClient({ hostId: "cursor-recovery", transport });
  try {
    await client.connect({ clientInfo: { name: "cursor-recovery", version: "1" } });
    await assert.rejects(readTurnsPage({ client, threadId: "a", requestTimeoutMs: 1000, signal: controller.signal }, "expired"));
    assert.deepEqual(cursors, kind === "repeated" ? ["expired", "fresh-1"] : ["expired"],
      "generic invalid params and cancellation cannot issue a replacement; repeated expiry cannot loop");
  } finally { await client.close(); }
});
