import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { startOrchestrationCallbackRelay } from "../../apps/codex-core/src/orchestration-callback-lane";

test(
  "real native private allocation stays undiscoverable until the Hub publishes ownership",
  { skip: !process.env.OPENCRAFT_CODEX_EXECUTABLE, timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp("/tmp/native-publication-"),
      native = join(directory, "native.sock"),
      endpoint = join(directory, "relay.sock"),
      faultEndpoint = join(directory, "fault.sock");
    await writeFile(
      join(directory, "config.toml"),
      'model_provider="fixture"\n[model_providers.fixture]\nname="local"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nrequires_openai_auth=false\n',
    );
    const child = spawn(process.env.OPENCRAFT_CODEX_EXECUTABLE!, ["app-server", "--listen", "unix://" + native], {
      env: { ...process.env, CODEX_HOME: directory },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const faultServer = createServer(),
      faultSockets: WebSocket[] = [];
    const faultWss = new WebSocketServer({ server: faultServer });
    faultWss.on("connection", (socket) => {
      const upstream = new WebSocket(`ws+unix://${native}:/`);
      faultSockets.push(socket, upstream);
      const queued: Buffer[] = [];
      socket.on("message", (frame) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(frame, { binary: false });
        else queued.push(Buffer.from(frame as Buffer));
      });
      upstream.on("open", () => {
        for (const frame of queued) upstream.send(frame, { binary: false });
        queued.length = 0;
      });
      upstream.on("message", (frame) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(frame, { binary: false });
      });
      socket.on("close", () => upstream.terminate());
      upstream.on("close", () => socket.terminate());
      socket.on("error", () => upstream.terminate());
      upstream.on("error", () => socket.terminate());
    });
    await new Promise<void>((resolve) => faultServer.listen(faultEndpoint, resolve));
    let relay: Awaited<ReturnType<typeof startOrchestrationCallbackRelay>> | undefined;
    const sockets: WebSocket[] = [];
    t.after(async () => {
      for (const socket of sockets) socket.terminate();
      await relay?.close();
      for (const socket of faultSockets) socket.terminate();
      faultWss.close();
      await new Promise<void>((resolve) => faultServer.close(() => resolve()));
      child.kill();
      await exited;
      await rm(directory, { recursive: true, force: true });
    });
    // Waiting for the native listener is a read-only readiness check, not a model call.
    const { stat } = await import("node:fs/promises");
    for (let n = 0; ; n++) {
      try {
        if ((await stat(native)).isSocket()) break;
      } catch {}
      if (n >= 100) throw Error("Native listener unavailable");
      await new Promise((r) => setTimeout(r, 50));
    }
    relay = await startOrchestrationCallbackRelay(endpoint, faultEndpoint);
    async function peer(lane: string) {
      const socket = new WebSocket(`ws+unix://${endpoint}:/?opencraftLane=${lane}`);
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      let sequence = 0;
      const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>(),
        events: any[] = [];
      socket.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.method) events.push(m);
        const p = pending.get(m.id);
        if (p) {
          pending.delete(m.id);
          m.error ? p.reject(Object.assign(Error(m.error.message), { code: m.error.code })) : p.resolve(m.result);
        }
      });
      const call = (method: string, params: unknown = {}) =>
        new Promise<any>((resolve, reject) => {
          const id = ++sequence;
          pending.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method, params }));
        });
      await call("initialize", {
        clientInfo: { name: "private-allocation-proof", version: "1" },
        capabilities: { experimentalApi: true },
      });
      socket.send(JSON.stringify({ method: "initialized" }));
      return { call, events, socket };
    }
    const owner = await peer("owner"),
      other = await peer("viewer");
    assert.equal((await owner.call("opencraft/orchestration/private-capability")).version, 1);
    const created = await owner.call("thread/start", {
      cwd: directory,
      model: "fixture",
      sandbox: "read-only",
      approvalPolicy: "never",
      __opencraftOrchestrationOperation: "private-native",
      __opencraftDeferPublication: true,
    });
    const id = created.thread.id;
    assert.equal(typeof id, "string");
    assert.equal(
      other.events.some((e) => e.params?.thread?.id === id),
      false,
    );
    assert.equal((await other.call("thread/loaded/list")).data.includes(id), false);
    await assert.rejects(other.call("thread/read", { threadId: id }), { code: -32004 });
    // Interrupt only the real native connection, leaving both processes alive.
    const disconnected = new Promise<void>((resolve) => owner.socket.once("close", () => resolve()));
    faultSockets[0]!.terminate();
    await disconnected;
    const replacement = await peer("owner");
    const replay = await replacement.call("thread/start", {
      cwd: directory,
      model: "fixture",
      sandbox: "read-only",
      approvalPolicy: "never",
      __opencraftOrchestrationOperation: "private-native",
      __opencraftDeferPublication: true,
    });
    assert.equal(replay.thread.id, id);
    assert.equal(
      (await replacement.call("opencraft/orchestration/publish", { operationId: "private-native" })).published,
      true,
    );
    assert.equal((await other.call("thread/loaded/list")).data.includes(id), true);
    // The real Hub ThreadAccess layer applies the committed Human-private policy
    // after this transport barrier releases. This probe contains no Human data.
    assert.equal(
      other.events.some((e) => e.params?.thread?.id === id),
      true,
    );
  },
);
