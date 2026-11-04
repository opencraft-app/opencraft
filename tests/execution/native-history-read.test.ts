import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { GenerationPeer } from "../../apps/codex-core/src/generation-peer.js";
import { nativeHistoryFailures, readNativeHistory } from "../../apps/codex-core/src/native-history-read.js";

test("native cold history carries only exact old-reader failures and rejects every changed outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-history-")), server = createServer(), ws = new WebSocketServer({ server });
  const error = { code: -32600, message: "Synthetic unloaded historical record" };
  const expected = nativeHistoryFailures({ version: 1, failures: [{ generationId: "old", threadId: "bad", reads: [false, true].map(includeTurns => ({ includeTurns, code: error.code, errorSha256: createHash("sha256").update(JSON.stringify(error)).digest("hex") })) }] });
  let mode = "exact"; const calls: { method: string; params: any }[] = [];
  ws.on("connection", socket => socket.on("message", raw => {
    const m = JSON.parse(String(raw)); calls.push(m); if (m.id === undefined) return;
    let outcome: any = { result: m.method === "thread/loaded/list" ? { data: mode === "loaded" ? ["bad"] : [] } : m.method === "thread/read" ? { thread: { id: m.params.threadId } } : {} };
    if (m.method === "thread/read" && (m.params.threadId === "bad" && mode !== "success" || m.params.threadId === "good" && mode === "extra")) {
      outcome = { error: mode === "code" ? { ...error, code: -32601 } : mode === "message" ? { ...error, message: "Different failure" } : mode === "second" && m.params.includeTurns ? { ...error, code: -32601 } : error };
    }
    socket.send(JSON.stringify({ id: m.id, ...outcome }));
  }));
  const endpoint = join(root, "native.sock"); await new Promise<void>(r => server.listen(endpoint, r));
  const { peer } = await GenerationPeer.open(endpoint, {}, { message() {}, disconnected() {} });
  try {
    assert.deepEqual(await readNativeHistory(peer, "old", ["good", "bad"], expected.failures), { historicalCount: 2, failures: expected.failures });
    assert.deepEqual(calls.filter(c => c.method === "thread/read" && c.params.threadId === "bad").map(c => c.params.includeTurns), [false, true]);
    for (mode of ["extra", "code", "message", "second", "success", "loaded"]) await assert.rejects(readNativeHistory(peer, "old", ["good", "bad"], expected.failures), undefined, mode);
    mode = "exact";
    await assert.rejects(readNativeHistory(peer, "old", ["good"], expected.failures), /binding changed/);
    await assert.rejects(readNativeHistory(peer, "new", ["bad"], expected.failures), /binding changed/);
    await assert.rejects(readNativeHistory(peer, "old", ["bad"], []));
    assert.equal(calls.some(c => c.method === "thread/resume"), false);
    assert.throws(() => nativeHistoryFailures({ version: 1, failures: [...expected.failures, ...expected.failures] }));
    assert.throws(() => nativeHistoryFailures({ version: 1, failures: [{ ...expected.failures[0], reads: [expected.failures[0]!.reads[0]] }] }));
  } finally { peer.close(); for (const socket of ws.clients) socket.terminate(); await new Promise<void>(r => ws.close(() => r())); await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }); }
});
