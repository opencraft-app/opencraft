import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { AbsentDshClient } from "../../apps/local-agent-host/src/dsh-absent-client.js";
import { DshSupervisor } from "../../apps/local-agent-host/src/dsh-supervisor.js";
import { startLocalAgentHost } from "../../apps/local-agent-host/src/main.js";

// OpenCraft bridges DSH but does not distribute it. A host without an
// installed runtime still starts and serves its other engines.
test("DSH availability is a probe, not a start", async () => {
  const missing = new DshSupervisor({ executable: "/nonexistent/dsh/lib/bin.js" });
  assert.equal(await missing.available(), false);
  await assert.rejects(missing.start(), /DSH runtime is missing/);
});

test("the absent client answers initialization reads and refuses everything else", async () => {
  const client = new AbsentDshClient({} as never);
  assert.deepEqual(await client.call("session.list"), { items: [] });
  assert.deepEqual(await client.call("llm.models"), { groups: [], failures: [] });
  await assert.rejects(
    client.call("session.create"),
    (error: any) => error.code === "DSH_UNAVAILABLE" && /not installed/.test(error.message),
  );
  const abort = new AbortController();
  let opened = false;
  const stream = client.stream(
    "/api/events.mux",
    () => assert.fail("no native frames"),
    abort.signal,
    () => {
      opened = true;
    },
  );
  assert.equal(opened, true);
  abort.abort();
  await stream;
});

test("a local host without DSH starts, initializes and reports DSH threads as not installed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oc-host-no-dsh-"));
  const previous = { url: process.env.OPENCRAFT_DSH_URL, repository: process.env.OPENCRAFT_DSH_REPOSITORY };
  delete process.env.OPENCRAFT_DSH_URL;
  delete process.env.OPENCRAFT_DSH_REPOSITORY;
  const host = await startLocalAgentHost({
    dataDirectory: directory,
    modelStorageDirectory: join(directory, "models"),
    runtimeDirectory: join(directory, "runtime"),
    dshExecutable: join(directory, "missing/dsh/lib/bin.js"),
  });
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const value = new WebSocket(host.websocketUrl);
    value.once("open", () => resolve(value));
    value.once("error", reject);
  });
  t.after(async () => {
    socket.close();
    await host.close();
    await rm(directory, { recursive: true, force: true });
    if (previous.url !== undefined) process.env.OPENCRAFT_DSH_URL = previous.url;
    if (previous.repository !== undefined) process.env.OPENCRAFT_DSH_REPOSITORY = previous.repository;
  });
  let id = 0;
  const request = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const current = ++id;
      const listener = (data: WebSocket.RawData) => {
        const frame = JSON.parse(data.toString());
        if (frame.id !== current) return;
        socket.off("message", listener);
        frame.error === undefined ? resolve(frame.result) : reject(frame.error);
      };
      socket.on("message", listener);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: current, method, params }));
    });
  assert.ok(await request("initialize", {}));
  assert.deepEqual(
    (await request("thread/list", {})).data.filter(
      (thread: any) => !/^(codex|claude|cursor|codebuddy|pi)/.test(thread.id),
    ),
    [],
  );
  // Only connected agents on this computer contribute models; DSH offers none.
  assert.ok((await request("model/list", {})).data.every((model: any) => typeof model.agentId === "string"));
  assert.deepEqual((await request("runtime/models/list", {})).groups, []);
  // No DSH model exists to start a thread with, and the runtime reports DSH as missing.
  await assert.rejects(request("thread/start", {}));
  assert.equal((await request("runtime/status/read", {})).version, "not installed");
});
