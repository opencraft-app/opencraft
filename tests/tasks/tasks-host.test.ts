import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { TASKS } from "@opencraft/appserver-protocol";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { startLocalAgentHost } from "../../apps/local-agent-host/src/main";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter";

test("authenticated Local Agent Host exposes SQLite rows to multiple clients and survives restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-tasks-host-"));
  let host: Awaited<ReturnType<typeof startLocalAgentHost>> | undefined;
  const sockets: WebSocket[] = [];
  const connect = async () => {
    const socket = new WebSocket(host!.websocketUrl);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    let sequence = 0;
    return (method: string, params: unknown) =>
      new Promise<any>((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          socket.off("message", receive);
          reject(new Error("RPC timeout"));
        }, 4000);
        const receive = (data: WebSocket.RawData) => {
          const response = JSON.parse(String(data));
          if (response.id !== id) return;
          clearTimeout(timer);
          socket.off("message", receive);
          if (response.error) reject(response.error);
          else resolve(response.result);
        };
        socket.on("message", receive);
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
  };
  try {
    host = await startLocalAgentHost({
      dshUrl: "http://127.0.0.1:1",
      dataDirectory: root,
    });
    const invalid = new URL(host.websocketUrl);
    invalid.searchParams.set("token", "bad");
    const denied = new WebSocket(invalid);
    denied.on("error", () => {});
    const status = await new Promise<number>((resolve, reject) => {
      denied.once("unexpected-response", (_req, res) => {
        res.resume();
        denied.terminate();
        resolve(res.statusCode!);
      });
      denied.once("open", () => {
        denied.close();
        reject(new Error("Unauthorized connection accepted"));
      });
    });
    assert.equal(status, 401);
    const a = await connect(),
      b = await connect();
    assert.equal((await a(TASKS.capabilities, {})).storage, "sqlite-rows");
    const notifications: string[] = [];
    sockets[1].on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.method) notifications.push(frame.method);
    });
    await a(TASKS.create, {
      id: "task",
      title: "One",
      description: "",
      status: "todo",
      projectServerId: null,
      projectId: null,
    });
    assert.equal((await b(TASKS.read, { id: "task" })).title, "One");
    assert.ok(notifications.includes("opencraft/tasks/changed"));
    await b(TASKS.move, {
      id: "task",
      expectedRevision: 1,
      status: "in_progress",
      beforeId: null,
    });
    await assert.rejects(
      a(TASKS.remove, { id: "task", expectedRevision: 1 }),
      (error: any) => error.code === -32051,
    );
    const removed = await b(TASKS.remove, { id: "task", expectedRevision: 2 });
    assert.equal(removed.tasks.length, 0);
    assert.equal(removed.recycled[0].id, "task");
    assert.equal((await a(TASKS.capabilities, {})).archive, true);
    sockets.forEach((socket) => socket.close());
    await host.close();
    host = await startLocalAgentHost({
      dshUrl: "http://127.0.0.1:1",
      dataDirectory: root,
    });
    const restarted = await connect();
    const recycled = (await restarted(TASKS.list, {})).recycled[0];
    await restarted(TASKS.restore, { id: recycled.id, expectedRevision: recycled.revision });
    assert.equal(
      (await restarted(TASKS.read, { id: "task" })).status,
      "in_progress",
    );
    const restoredTask = await restarted(TASKS.read, { id: "task" });
    await restarted(TASKS.archive, { id: "task", expectedRevision: restoredTask.revision });
    assert.equal((await restarted(TASKS.list, {})).tasks.length, 0);
    const archivePage = await restarted(TASKS.archives, { search: "One", limit: 1 });
    assert.equal(archivePage.tasks[0].id, "task");
    assert.equal((await restarted(TASKS.read, { id: "task" })).status, "in_progress");
    await restarted(TASKS.unarchive, { id: "task", expectedRevision: archivePage.tasks[0].revision });
    assert.equal((await restarted(TASKS.list, {})).tasks[0].id, "task");
  } finally {
    sockets.forEach((socket) => socket.close());
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("local Codex adapter owns Tasks RPC instead of forwarding it to native Codex", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-tasks-codex-"));
  const adapter = new CodexEngineAdapter({
    executable: process.execPath,
    runtimeDirectory: root,
    dataDirectory: join(root, "data"),
    nativeCodexHomeDirectory: join(root, "native"),
    upstreamBaseUrl: "http://127.0.0.1:9",
    fetch: async () => Response.json({}),
    spawnAppServer: ({ cwd, env }) =>
      spawn(
        process.execPath,
        [
          new URL("../fixtures/fake-codex-stdio-appserver.mjs", import.meta.url)
            .pathname,
        ],
        { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
      ),
    createMaintenanceClient: async () => {
      throw new Error("unused");
    },
    logDiagnostic: () => {},
  });
  let sequence = 0;
  const call = async (method: string, params: unknown): Promise<any> => {
    const id = ++sequence;
    const reply = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        remove();
        reject(new Error("Adapter timeout"));
      }, 4000);
      const remove = adapter.subscribeMessage((frame) => {
        const response = JSON.parse(frame);
        if (response.id !== id) return;
        clearTimeout(timer);
        remove();
        if (response.error) reject(response.error);
        else resolve(response.result);
      });
    });
    await adapter.send(
      JSON.stringify({
        id,
        method,
        params,
        [LOGICAL_CLIENT_FIELD]: "tasks-test",
      }),
    );
    return reply;
  };
  try {
    await adapter.connect();
    await assert.rejects(
      call(TASKS.list, {}),
      (error: any) => error.code === -32600,
    );
    await call("initialize", {});
    assert.deepEqual(await call(TASKS.capabilities, {}), {
      version: 1,
      storage: "sqlite-rows",
      properties: true,
      memberIdentity: true,
      archive: true, aiResearch: true, planning: true, activity: true, progress: true,
      supportedKinds: ["unclassified", "feature", "improvement", "bug", "engineering", "harness", "research", "documentation", "operations", "growth", "task"],
      recycleBinRetentionMs: 7 * 86400000,
    });
    await call(TASKS.create, {
      id: "native",
      title: "Native",
      description: "",
      status: "todo",
      projectServerId: null,
      projectId: null,
    });
    assert.equal((await call(TASKS.read, { id: "native" })).title, "Native");
    assert.equal((await call(TASKS.list, {})).tasks.length, 1);
    const removed = await call(TASKS.remove, { id: "native", expectedRevision: 1 });
    assert.equal(removed.recycled[0].id, "native");
    const restored = await call(TASKS.restore, { id: "native", expectedRevision: removed.recycled[0].revision });
    assert.equal(restored.tasks[0].id, "native"); assert.equal(restored.recycled.length, 0);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});
