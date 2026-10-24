import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { AppServerRpcError, type ExecutionEngineProvider } from "@opencraft/appserver-client";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { startEngineHost } from "../../apps/local-agent-host/src/engine-host.js";

test("oversized provider history and archived resume fail their RPC, leaving peer sessions connected", async t => {
  const directory = await mkdtemp(join(tmpdir(), "history-isolation-"));
  const provider: ExecutionEngineProvider = { id: "pi", label: "Pi fixture", threadPrefix: "pi_", modelPrefix: "pi:", extensions: {},
    ownsThread: id => id.startsWith("pi_"), ownsModel: id => id.startsWith("pi:"), subscribe: () => () => {}, disconnect() {}, async close() {},
    async request(method, params) {
      if (params.threadId === "pi_archived") throw new AppServerRpcError({ code: -32071, message: "Archived", data: { code: "THREAD_ARCHIVED", retryable: false } });
      if (method === "thread/resume") return { thread: { id: params.threadId, turns: [] } };
      if (params.threadId === "pi_large") return { data: [{ items: [{ text: "x".repeat(9 * 1024 * 1024) }] }] };
      if (method === "thread/turns/list") return { data: [{ id: "peer-turn", items: [] }], nextCursor: null };
      return { data: [], nextCursor: null };
    } };
  const host = await startEngineHost({ providers: [provider], defaultEngine: "pi", resources: { projectDirectory: directory } });
  const socket = new WebSocket(host.websocketUrl); await once(socket, "open");
  t.after(async () => { socket.terminate(); await host.close(); await rm(directory, { recursive: true, force: true }); });
  let next = 0;
  const call = (method: string, threadId?: string, clientId = "one") => new Promise<any>((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { socket.off("message", receive); reject(new Error("No RPC response")); }, 3000);
    const receive = (data: WebSocket.RawData) => { const frame = JSON.parse(String(data)); if (frame.id !== id) return;
      clearTimeout(timer); socket.off("message", receive); resolve(frame); };
    socket.on("message", receive); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: { threadId }, [LOGICAL_CLIENT_FIELD]: clientId }));
  });
  await call("initialize");
  await call("thread/resume", "pi_large"); await call("thread/resume", "pi_peer", "two");
  await call("thread/resume", "pi_peer");
  const [large, peer] = await Promise.all([call("thread/turns/list", "pi_large"), call("thread/turns/list", "pi_peer", "two")]);
  assert.equal(large.error?.data?.code, "HISTORY_RESPONSE_TOO_LARGE"); assert.equal(large.error.data.retryable, false);
  assert.equal(large[LOGICAL_CLIENT_FIELD], "one"); assert.equal(peer.result.data[0].id, "peer-turn");
  const archived = await call("thread/resume", "pi_archived"); assert.equal(archived.error.code, -32071);
  assert.deepEqual(archived.error.data, { code: "THREAD_ARCHIVED", retryable: false });
  assert.equal(socket.readyState, WebSocket.OPEN); assert.equal((await call("thread/turns/list", "pi_peer")).result.data[0].id, "peer-turn");
});
