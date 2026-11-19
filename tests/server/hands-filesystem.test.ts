import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { startHostFileSystem, createHostFileSystem } from "../../scripts/host-filesystem.js";
import { HostFileSystemSession } from "../../scripts/host-filesystem-transport.js";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { WebSocket, WebSocketServer } from "ws";
import { startHeadlessServer } from "../../scripts/headless-server.mjs";

async function fixture(t: test.TestContext, concurrency = 4) {
  const root = await mkdtemp(join(tmpdir(), "hands-files-"));
  const options = { endpoint: join(root, "files.sock"), tokenFile: join(root, "files.token"), concurrency };
  const owner = await startHostFileSystem(options),
    client = createHostFileSystem(options);
  t.after(async () => {
    client.close();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, options, client };
}

test("Hands owns directory, metadata, exact binary bytes, symlinks and authenticated streaming", async (t) => {
  const { root, options, client } = await fixture(t);
  const file = join(root, "中文 file.bin"),
    bytes = Buffer.from([0, 255, 1, 128, 10]);
  await client.probe();
  await client.request("fs/writeFile", { path: file, dataBase64: bytes.toString("base64") });
  await symlink(file, join(root, "link"));
  assert.equal(((await client.request("fs/getMetadata", { path: join(root, "link") })) as any).isSymlink, true);
  assert.ok(
    ((await client.request("fs/readDirectory", { path: root })) as any).entries.some(
      (entry: any) => entry.fileName === "中文 file.bin" && entry.isFile,
    ),
  );
  assert.deepEqual(
    Buffer.from(((await client.request("fs/readFile", { path: file })) as any).dataBase64, "base64"),
    bytes,
  );
  const stream = await client.openFile(file, false, new AbortController().signal);
  assert.equal(stream.size, bytes.length);
  const chunks = [];
  for await (const chunk of stream.body) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  await stream.dispose();
  const head = await client.openFile(file, true, new AbortController().signal);
  assert.equal(head.size, bytes.length);
  await head.dispose();
  const status = await new Promise((resolve) => {
    const req = request({ socketPath: options.endpoint, path: "/health" }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.end();
  });
  assert.equal(status, 401);
  await chmod(options.tokenFile, 0o644);
  await assert.rejects(client.probe(), /credential unavailable/);
});

test("reads remain concurrent while a large stream is stalled, and abort releases a queued request", async (t) => {
  const { root, client } = await fixture(t, 2);
  const large = join(root, "large");
  const handle = await open(large, "w");
  await handle.truncate(64 * 1024 * 1024);
  await handle.close();
  const stream = await client.openFile(large, false, new AbortController().signal);
  try {
    await client.request("fs/getMetadata", { path: large }, AbortSignal.timeout(2000));
    const second = await client.openFile(large, false, new AbortController().signal);
    try {
      const cancelled = new AbortController();
      const pending = client.request("fs/getMetadata", { path: large }, cancelled.signal);
      cancelled.abort();
      await assert.rejects(pending);
    } finally {
      await second.dispose();
    }
  } finally {
    await stream.dispose();
  }
  await client.request("fs/getMetadata", { path: large }, AbortSignal.timeout(2000));
  await assert.rejects(client.request("fs/readFile", { path: large }));
});

test("writes do not overlap, and invalid requests, preview escapes and duplicate owners fail closed", async (t) => {
  const { root, options, client } = await fixture(t);
  await client.request("fs/createDirectory", { path: join(root, "nested/deeper") });
  await client.request("fs/createDirectory", { path: join(root, "preview") });
  const file = join(root, "value");
  const contents = Array.from({ length: 8 }, (_, index) => Buffer.alloc(1024 * 1024, index));
  await Promise.all(
    contents.map((data) => client.request("fs/writeFile", { path: file, dataBase64: data.toString("base64") })),
  );
  const result = await readFile(file);
  assert.equal(result.length, 1024 * 1024);
  assert.ok(result.every((byte) => byte === result[0]));
  await symlink(file, join(root, "preview/escape"));
  await assert.rejects(
    client.openFile(join(root, "preview/escape"), false, new AbortController().signal, join(root, "preview")),
  );
  for (const [method, params] of [
    ["fs/readDirectory", { path: "relative" }],
    ["fs/readFile", { path: file, command: "ignored" }],
    ["fs/writeFile", { path: file, dataBase64: "bad***" }],
    ["fs/createDirectory", { path: file, recursive: "true" }],
  ] as const)
    await assert.rejects(client.request(method, params));
  await assert.rejects(startHostFileSystem(options), /already running/);
  await client.probe();
});

test("logical clients route files without a native fallback and discard revoked or disconnected replies", async () => {
  let allow = true,
    calls = 0,
    settle!: (value: unknown) => void;
  const files = {
    request: async () => {
      calls++;
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  } as any;
  const session = new HostFileSystemSession(files, () => {
    if (!allow) throw Error("revoked");
  });
  const replies: any[] = [];
  session.subscribeMessage((frame) => replies.push(JSON.parse(frame)));
  const wire = (client: string, id: string, method: string, params = {}) =>
    JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client });
  const context = { sender: null };
  await session.receive(wire("a", "early", "fs/readFile"), context);
  assert.equal(calls, 0);
  await session.receive(wire("a", "init", "initialize"), context);
  session.project(JSON.stringify({ id: "init", result: { capabilities: {} }, [LOGICAL_CLIENT_FIELD]: "a" }));
  const first = session.receive(wire("a", "same-id", "fs/readFile"), context);
  assert.equal(calls, 1);
  allow = false;
  settle({ dataBase64: "c2VjcmV0" });
  await first;
  assert.ok(replies.at(-1).error);
  assert.equal(replies.at(-1).result, undefined);
  allow = true;
  const second = session.receive(wire("a", "same-id", "fs/readFile"), context);
  await session.receive(wire("a", "bye", "runtime/client/disconnect"), context);
  const count = replies.length;
  settle({ dataBase64: "c2VjcmV0" });
  await second;
  assert.equal(replies.length, count);
  assert.equal(await session.receive(wire("ssh:other", "model", "model/list"), context), false);
  session.close();
});

test("authenticated Gateway routes AppHost, raw AppServer and streamed downloads through Hands across reconnect", async (t) => {
  const { root, options } = await fixture(t),
    webRoot = join(root, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<title>Files fixture</title>");
  await writeFile(
    join(webRoot, "version.json"),
    JSON.stringify({
      schemaVersion: 1,
      buildId: "files-test",
      headlessServer: true,
      headlessHostId: "opencraft-server",
    }),
  );
  const nativeFiles: string[] = [];
  class Engine {
    status = { state: "idle" as "idle" | "open" | "closed" };
    listeners = new Set<(frame: string) => void>();
    async connect() {
      this.status = { state: "open" };
    }
    async close() {
      this.status = { state: "closed" };
    }
    subscribeStatus() {
      return () => {};
    }
    subscribeMessage(fn: (frame: string) => void) {
      this.listeners.add(fn);
      return () => {
        this.listeners.delete(fn);
      };
    }
    async send(frame: string) {
      const value = JSON.parse(frame);
      if (value.id == null) return;
      if (value.method.startsWith("fs/")) nativeFiles.push(value.method);
      const reply = {
        id: value.id,
        [LOGICAL_CLIENT_FIELD]: value[LOGICAL_CLIENT_FIELD],
        ...(value.method === "initialize"
          ? { result: { capabilities: {} } }
          : { error: { code: -32603, message: "local filesystem is not configured" } }),
      };
      for (const fn of this.listeners) fn(JSON.stringify(reply));
    }
  }
  const agent = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((accept) => agent.once("listening", accept));
  t.after(async () => {
    for (const socket of agent.clients) socket.terminate();
    await new Promise<void>((accept) => agent.close(() => accept()));
  });
  agent.on("connection", (socket) => {
    const engine = new Engine();
    engine.subscribeMessage((frame) => socket.readyState === 1 && socket.send(frame));
    socket.on("message", (raw) => {
      void engine.send(raw.toString());
    });
  });
  const principal = {
    provider: "files-fixture",
    subject: "alice",
    displayName: "Alice",
    expiresAt: Date.now() + 60000,
  };
  const app = await startHeadlessServer(
    {
      root,
      webRoot,
      dataDirectory: join(root, "gateway"),
      port: 0,
      accessMemberProviders: [principal.provider],
      fileSystemOwner: options,
      createCodexTransport: () => new Engine(),
      startAgentHost: async () => ({
        websocketUrl: "ws://127.0.0.1:" + (agent.address() as any).port + "/rpc",
        close() {},
      }),
    },
    {
      createIdentity: async () => ({
        providers: [{ authenticate: (req: any) => (req.headers["x-fixture-proof"] === "verified" ? principal : null) }],
        close() {},
      }),
    },
  );
  t.after(() => app.close());
  let sequence = 0;
  async function connection(raw = false, hostId = "local-codex") {
    const leaseId = "files-" + ++sequence,
      frames: any[] = [];
    const socket = new WebSocket(app.url.replace(/^http/, "ws") + (raw ? "/appserver" : "/apphost"), {
      origin: app.url,
      headers: { "x-fixture-proof": "verified" },
    });
    t.after(() => socket.terminate());
    socket.on("message", (frame) => frames.push(JSON.parse(frame.toString())));
    await new Promise<void>((accept, reject) => {
      socket.once("open", accept);
      socket.once("error", reject);
    });
    async function wait(accept: (frame: any) => boolean) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const value = frames.find(accept);
        if (value) return value;
        await new Promise((accept) => setTimeout(accept, 10));
      }
      throw Error("Gateway filesystem response timed out");
    }
    let generation: number;
    if (!raw) {
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 2, rendererId: leaseId }));
      await wait((frame) => frame.type === "ready");
      socket.send(JSON.stringify({ type: "host/connect", hostId, leaseId, requestId: leaseId }));
      const ready = await wait((frame) => frame.type === "response" && frame.requestId === leaseId);
      assert.equal(ready.ok, true);
      generation = ready.result.generation;
    }
    async function rpc(method: string, params = {}) {
      const id = ++sequence,
        frame = JSON.stringify({ id, method, params });
      socket.send(
        raw ? frame : JSON.stringify({ type: "host/send", requestId: String(id), hostId, leaseId, generation, frame }),
      );
      const value = await wait((frame) =>
        raw ? frame.id === id : frame.type === "host/frame" && JSON.parse(frame.frame).id === id,
      );
      const reply = raw ? value : JSON.parse(value.frame);
      assert.equal(reply.error, undefined, JSON.stringify(reply));
      return reply.result;
    }
    await rpc("initialize", { clientInfo: { name: "files-fixture", version: "1" } });
    return { socket, rpc };
  }
  const first = await connection(),
    path = join(root, "image.png"),
    data = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    );
  await first.rpc("fs/writeFile", { path, dataBase64: data.toString("base64") });
  assert.ok(
    (await first.rpc("fs/readDirectory", { path: root })).entries.some((entry: any) => entry.fileName === "image.png"),
  );
  first.socket.close();
  const second = await connection();
  assert.equal((await second.rpc("fs/readFile", { path })).dataBase64, data.toString("base64"));
  for (const owner of [await connection(true), await connection(false, "opencraft-server")])
    assert.equal((await owner.rpc("fs/getMetadata", { path })).isFile, true);
  const url = app.url + "/__opencraft_files?" + new URLSearchParams({ hostId: "local-codex", path });
  const headers = { "x-fixture-proof": "verified", origin: app.url };
  const download = await fetch(url, { headers });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), data);
  const head = await fetch(url, { method: "HEAD", headers });
  assert.equal(head.headers.get("content-length"), String(data.length));
  assert.notEqual((await fetch(url)).status, 200);
  assert.deepEqual(nativeFiles, []);
});

test("artifact delivery streams beyond RPC limits, reuses registered bytes and rejects corruption", async (t) => {
  const { root, client } = await fixture(t);
  const { ArtifactCatalog, artifactFileBody } = await import("../../apps/local-agent-host/src/artifacts/catalog.js");
  const source = new ArtifactCatalog(join(root, "brain-artifacts"));
  t.after(() => source.close());
  const file = join(root, "source.bin");
  const handle = await open(file, "w");
  await handle.truncate(40 * 1024 * 1024 + 7);
  await handle.close();
  const artifact = await source.ingest(
    { scope: "test", key: "large" },
    { name: "movie.mp4", mimeType: "video/mp4", origin: "upload" },
    artifactFileBody(file),
    { maxBytes: 64 * 1024 * 1024, reference: { owner: "message", slot: "video" } },
  );
  const delivered = await client.prepareArtifact(artifact, "thread/one");
  assert.notEqual(delivered.path, artifact.path);
  const { inspectArtifactFile } = await import("../../apps/local-agent-host/src/artifacts/catalog.js");
  assert.deepEqual(await inspectArtifactFile(delivered.path), { size: artifact.size, sha256: artifact.sha256 });
  assert.equal((await client.prepareArtifact(artifact, "thread/two")).path, delivered.path);
  await writeFile(delivered.path, "corrupt");
  await assert.rejects(client.prepareArtifact(artifact, "thread/three"));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(client.prepareArtifact(artifact, "thread/four", aborted.signal));
});

test("interrupted artifact upload leaves neither a committed object nor a partial content file", async (t) => {
  const { root, options, client } = await fixture(t);
  const metadata = {
    id: "a".repeat(64),
    name: "interrupted.bin",
    mimeType: "application/octet-stream",
    size: 40 * 1024 * 1024,
    sha256: "b".repeat(64),
    owner: "thread/interrupted",
  };
  const credential = (await readFile(options.tokenFile, "utf8")).trim();
  const req = request({
    socketPath: options.endpoint,
    path: "/artifact",
    method: "POST",
    headers: {
      authorization: "Bearer " + credential,
      "content-length": String(metadata.size),
      "x-opencraft-artifact": Buffer.from(JSON.stringify(metadata)).toString("base64url"),
    },
  });
  req.on("error", () => {});
  req.write(Buffer.alloc(1024));
  const content = join(root, "artifact-copies", "content");
  const { readdir } = await import("node:fs/promises");
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 3000;
    while (!(await check())) {
      if (Date.now() > deadline) throw Error("Cleanup did not settle");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await until(async () => {
    try {
      return (await readdir(content)).length === 1;
    } catch {
      return false;
    }
  });
  req.destroy();
  await until(async () => (await readdir(content)).length === 0);
  await client.probe();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(root, "artifact-copies", "catalog.sqlite"), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM artifacts").get()!.n, 0);
  } finally {
    db.close();
  }
});
