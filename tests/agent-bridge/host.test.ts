import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, resolveStoreMigrations } from "@opencraft/sqlite-node";
import {
  BridgeHost,
  GatewayInbox,
  attachGateway,
  dispatchSettlement,
  type Generation,
  type OutboxEvent,
} from "../../apps/agent-bridge-host/src/index.js";
import { Storage } from "../../apps/agent-bridge-host/src/storage.js";
import { BridgeGateway } from "../../apps/agent-bridge-host/src/gateway.js";
import { HostQueue } from "../../apps/agent-bridge-host/src/queue.js";
import { BridgeGatewaySession, BridgeOutboxReadError, pullBridgeInbox } from "../../apps/agent-bridge-host/src/gateway-session.js";
import { migrations } from "../../apps/agent-bridge-host/src/migrations.js";
import { localTestBackend } from "./fixtures/local-backend.js";
import {
  BRIDGE_MAX_COMMAND_BYTES, BRIDGE_MAX_FRAME_BYTES, BRIDGE_OUTBOX_FRAGMENT_BYTES, negotiateHandshake, type BridgeDeclaration,
} from "@opencraft/agent-bridge-protocol";
const token = "test-private-token-000000000000000000000";
const declaration: BridgeDeclaration = {
  providerId: "fake",
  protocolVersion: 1,
  grammarRange: { min: 1, max: 1 },
  approvalExecutor: "provider",
  minNativeVersion: "1",
  probeBasis: "fake fixture",
  capabilities: {
    model: false,
    reasoning: false,
    history: false,
    usage: false,
    approval: false,
    inputContentTypes: ["text"],
    cliExecutable: false,
    forkCheckpoint: false,
    skills: false,
    installation: false,
    steer: {
      deliveryMethods: [],
      evidenceKinds: [],
      withdrawal: "none",
      contentLimits: { maxBytes: 1024, allowedContentTypes: ["text"] },
      maxPendingWithoutNativeId: 1,
      fallbackPolicy: "reject-unknown",
    },
  },
};
async function config(root: string, id = "g1", hostPid = process.pid, cliExecutable = false): Promise<Generation> {
  const artifact = resolve("tests/agent-bridge/fixtures/fake-bridge.mjs");
  const provider = { ...declaration, capabilities: { ...declaration.capabilities, cliExecutable } };
  const handshake = negotiateHandshake({ protocolVersion: 1, grammarRange: { min: 1, max: 1 } }, provider);
  assert(handshake.ok);
  return {
    id,
    artifact,
    digest: createHash("sha256")
      .update(await readFile(artifact))
      .digest("hex"),
    provider,
    launch: {
      command: [process.execPath, artifact],
      cwd: root,
      env: {
        HANDSHAKE: JSON.stringify(handshake.result),
        EXECUTIONS: join(root, "executions"),
        HOST_PID: String(hostPid),
      },
    },
  };
}
const policy = { id: "test-bridge", capacity: { cpuMillis: 16000, memoryBytes: 32 * 1024 ** 3 } };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(25);
  }
  throw Error("Condition timed out");
}
async function setup(t: any, maxSpoolBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), "bridge-p1b-"));
  const host = await BridgeHost.open({
    path: join(root, "host.db"),
    policy,
    backend: localTestBackend(),
    maxSpoolBytes,
  });
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  await host.add(await config(root));
  await host.activate("g1", "");
  return { host, root };
}
const command = (commandId: string, method: string = "session/create", params = {}, threadId = "thread-1") => ({
  commandId,
  serverId: "server-1",
  threadId,
  method,
  params,
});
async function accepted(host: BridgeHost, id: string) {
  return until(
    () => host.query(id),
    (r) => r?.state === "accepted",
  );
}
async function rpc(url: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(url + path, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("a durable accepted receipt retains canonical identities while event delivery fails", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const gateway = new BridgeGatewaySession({
    serverId: "server-1",
    async request(path) {
      if (path === "/command") return Response.json({ state: "registered" });
      return Response.json({ state: "accepted", response: { result: { turn: { id: "native-turn" } } },
        identities: { nativeThreadId: "native-thread", turn: { nativeId: "native-turn", id: "public-turn" } } });
    },
    inbox: { async cursor() { return 0; }, async read() { return []; }, async readIdentities() { return []; }, async readPendingInteractions() { return []; },
      async pull() { await blocked; throw Error("event stream unavailable"); }, async close() {} },
  }, () => assert.fail("No stream event was produced"));
  try {
    const result = await gateway.command("public-thread", "accepted", "turn/start", {});
    assert.deepEqual(gateway.history("public-thread", result), { turn: { id: "public-turn" } });
    assert.equal(gateway.nativeThread("public-thread"), "native-thread");
    assert.ok(gateway.owns("public-thread"));
    assert.equal(gateway.nativeTurn("public-thread", "public-turn"), "native-turn");
    const pull = gateway.pull();
    release();
    await assert.rejects(pull, /event stream unavailable/);
  } finally {
    release();
    await gateway.close();
  }
});

test("a rejected direct input keeps its message identity and only one retried native start", async (t) => {
  const { host, root } = await setup(t);
  await host.accept(command("create"));
  await accepted(host, "create");
  const endpoint = await attachGateway(host, token);
  const gateway = new BridgeGateway({ url: endpoint.url, token, serverId: "server-1", inboxPath: join(root, "inbox.db") }, () => {});
  t.after(async () => { await gateway.close(); await endpoint.close(); });
  const native = { clientUserMessageId: "draft", input: [{ type: "text", text: "same draft" }] };
  const id = "bridge-mutation:" + createHash("sha256").update(JSON.stringify(["thread-1", "turn/start", "draft"])).digest("hex");
  // The old Host stored the digest with the MCP configuration. Keep that
  // persisted refusal as the predecessor of the retry.
  await assert.rejects(gateway.command("thread-1", id, "turn/start", {
    native, refuse: true, sessionMcp: { url: "old-configuration" },
  }), /Fixture refusal/);
  const options = { retryRejectedTurn: true } as const;
  const submit = (url: string) => gateway.command("thread-1", id, "turn/start", {
    native, sessionMcp: { url },
  }, undefined, options);
  const [result, duplicate] = await Promise.all([submit("first-retry"), submit("concurrent-retry")]);
  assert.deepEqual(result, duplicate);
  assert.deepEqual(await submit("another-configuration"), result);
  assert.equal((await host.query(id))?.state, "rejected");
  assert.equal((await host.query(id + ":retry:000000000001"))?.state, "accepted");
  assert.equal(await host.query(id + ":retry:000000000002"), null);
  assert.equal((await readFile(join(root, "executions"), "utf8")).trim().split("\n").length, 1);
  await assert.rejects(gateway.command("thread-1", id, "turn/start", {
    native: { ...native, input: [{ type: "text", text: "changed draft" }] },
  }, undefined, options), /commandId reused with different input/);
});

test("a replay cannot replace a direct input whose native outcome is unknown", async (t) => {
  const { host, root } = await setup(t);
  await host.accept(command("create"));
  await accepted(host, "create");
  const native = { clientUserMessageId: "uncertain", input: [{ type: "text", text: "maybe sent" }] };
  const id = "bridge-mutation:" + createHash("sha256").update(JSON.stringify(["thread-1", "turn/start", "uncertain"])).digest("hex");
  const request = { ...command(id, "turn/start", { native, refuseAfterStart: true, closeBeforeRefusal: true }), retryRejectedTurn: true };
  await host.accept(request);
  await until(() => host.query(id), receipt => receipt?.state === "unknown");
  const replay = await host.accept({ ...request, params: { ...request.params, sessionMcp: { url: "refreshed" } } });
  assert.equal(replay.state, "unknown");
  assert.equal(replay.commandId, id);
  assert.equal(await host.query(id + ":retry:000000000001"), null);
  assert.equal((await readFile(join(root, "executions"), "utf8")).trim().split("\n").length, 1);
});

test("a failed producer acknowledgement does not suppress committed inbox events", async () => {
  const row = {
    seq: 1, route: '["server-1","public-thread"]', generation: "g1",
    payload: { method: "thread/name/updated", params: { threadName: "Committed" } },
  };
  let committed = false;
  let failAck = true;
  const acked: number[] = [];
  const delivered: unknown[] = [];
  const gateway = new BridgeGatewaySession({
    serverId: "server-1",
    async request() { return Response.json(null); },
    inbox: {
      async cursor() { return Number(committed); },
      async read(after) { return committed && after < row.seq ? [row] : []; },
      async readIdentities() { return []; }, async readPendingInteractions() { return []; },
      pull: () => pullBridgeInbox(async (path, body) => {
        if (path === "/ack") {
          if (failAck) throw Error("connection reset");
          acked.push((body as { cursor: number }).cursor);
          return Response.json(null);
        }
        return Response.json(committed ? [] : [row]);
      }, {
        cursor: () => Number(committed),
        apply(batch) {
          committed ||= batch.length > 0;
          return { cursor: Number(committed), inserted: [...batch] };
        },
      }),
      async close() {},
    },
  }, (_threadId, event) => delivered.push(event));
  try {
    await gateway.pull();
    assert.deepEqual(acked, []);
    assert.deepEqual(delivered, [{ method: "thread/name/updated", params: { threadId: "public-thread", threadName: "Committed" } }]);
    failAck = false;
    await gateway.pull();
    assert.deepEqual(acked, [1]);
    assert.equal(delivered.length, 1);
  } finally {
    await gateway.close();
  }
});

test("passive metadata succeeds independently of the live outbox without exposing native turn IDs", async () => {
  const threadId = "public-thread";
  const requests: string[] = [];
  let pulls = 0;
  const gateway = new BridgeGatewaySession({
    serverId: "server-1",
    async request(path) {
      requests.push(path);
      assert.equal(path, "/observe");
      return Response.json({ thread: { id: "native-thread", turns: [{ id: "native-turn", items: [{ id: "native-item" }] }] } });
    },
    inbox: {
      async cursor() { return 0; },
      async read() { return []; },
      async readIdentities() { return []; }, async readPendingInteractions() { return []; },
      async pull() { pulls++; throw Error("outbox unavailable"); },
      async close() {},
    },
  }, () => assert.fail("A history read must not publish an event"));
  try {
    const metadata = await gateway.observe(threadId, { view: "thread", includeTurns: false });
    assert.deepEqual(gateway.history(threadId, metadata), { thread: { id: threadId, turns: [] } });
    assert.deepEqual(requests, ["/observe"]);
    assert.equal(pulls, 0);
    await assert.rejects(gateway.observe(threadId, { view: "thread", includeTurns: true }), /outbox unavailable/);
    assert.equal(pulls, 1, "complete history continues to require a current Turn and Item projection");
  } finally {
    await gateway.close();
  }
});

test("the Host HTTP route accepts commands past the old ceiling and reports oversize before custody", async (t) => {
  const { host } = await setup(t);
  await host.accept(command("create"));
  await accepted(host, "create");
  const endpoint = await attachGateway(host, token);
  t.after(() => endpoint.close());
  const input = (size: number) => ({ input: [{ type: "text", text: "x".repeat(size) }] });
  await rpc(endpoint.url, "/command", command("above-old-cap", "turn/start", input(550 * 1024)));
  await accepted(host, "above-old-cap");
  const response = await fetch(endpoint.url + "/command", {
    method: "POST", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(command("over-limit", "turn/start", input(BRIDGE_MAX_COMMAND_BYTES))),
  });
  assert.equal(response.status, 409);
  const error = await response.json();
  assert.equal(error.kind, "explicit-reject");
  assert.deepEqual(error.data, { code: "BRIDGE_REQUEST_TOO_LARGE", maxBytes: BRIDGE_MAX_COMMAND_BYTES });
  assert.equal(await host.query("over-limit"), null);
});

function seedOutbox(path: string, sizesMiB: readonly number[]) {
  const { database } = openManagedDatabase({ path, schemaId: "agent-bridge-host", migrations });
  try {
    const put = database.prepare("INSERT INTO outbox (route,generation,payload) VALUES (?,?,?)");
    for (const size of sizesMiB) {
      const payload = { method: "fixture", params: { text: "x".repeat(size * 1024 * 1024) } };
      put.run('["server-1","thread-1"]', "g1", JSON.stringify(payload));
    }
  } finally {
    database.close();
  }
}

test("outbox pages and a retained oversized event both advance the same fenced cursor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-outbox-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "host.db");
  seedOutbox(path, [9, 9, 18, 0]);
  const host = await BridgeHost.open({ path, policy, backend: localTestBackend() });
  const endpoint = await attachGateway(host, token);
  try {
    let cursor = 0;
    const batches: number[][] = [];
    let corrupt = false;
    let unavailableOffset: number | undefined;
    const request = async (url: string, body?: unknown) => {
      if (unavailableOffset !== undefined && url.endsWith(`&fragment=${unavailableOffset}`))
        return new Response(null, { status: 503 });
      const value = await rpc(endpoint.url, url, body);
      assert.ok(Buffer.byteLength(JSON.stringify(value)) <= BRIDGE_MAX_FRAME_BYTES + 2 * 1024 * 1024);
      if (corrupt && value.fragment?.offset === 0) {
        const { data } = value.fragment;
        value.fragment.data = (data.startsWith("A") ? "B" : "A") + data.slice(1);
      }
      return Response.json(value);
    };
    const store = { cursor: () => cursor, apply(batch: readonly { seq: number; payload: unknown }[], fence?: { acknowledged: number }) {
      assert.equal(fence?.acknowledged, cursor);
      for (const row of batch) assert.equal(row.seq, ++cursor);
      batches.push(batch.map(row => row.seq));
      return { cursor, inserted: [...batch] as any };
    } };
    const pull = () => pullBridgeInbox(request, store, { fenced: true, fragmentOversized: true });
    await pull();
    await pull();
    const continuationPath = `/events?cursor=2&fenced=1&fragment=${BRIDGE_OUTBOX_FRAGMENT_BYTES}`;
    const continuation = await rpc(endpoint.url, continuationPath);
    const first = await rpc(endpoint.url, "/events?cursor=2&fenced=1&fragment=0");
    assert.equal(continuation.outboxId, first.outboxId);
    assert.equal(continuation.fragment.seq, first.fragment.seq);
    assert.equal(continuation.fragment.digest, first.fragment.digest);
    assert.equal(continuation.fragment.offset, BRIDGE_OUTBOX_FRAGMENT_BYTES);
    const misaligned = await fetch(endpoint.url + "/events?cursor=2&fenced=1&fragment=1", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(misaligned.status, 409);
    unavailableOffset = BRIDGE_OUTBOX_FRAGMENT_BYTES;
    await assert.rejects(pull(), { constructor: BridgeOutboxReadError, status: 503, retryable: true });
    assert.equal(cursor, 2);
    assert.equal((await host.events(cursor, 256, true)).acknowledged, 2);
    unavailableOffset = undefined;
    corrupt = true;
    await assert.rejects(pull(), /Outbox event digest changed/);
    assert.equal(cursor, 2);
    assert.equal((await host.events(cursor, 256, true)).acknowledged, 2);
    corrupt = false;
    await pull();
    const acknowledgedContinuation = await fetch(endpoint.url + continuationPath, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(acknowledgedContinuation.status, 409);
    await pull();
    assert.deepEqual(batches, [[1], [2], [3], [4]]);
    assert.equal((await host.events(cursor, 256, true)).acknowledged, 4);
  } finally {
    await endpoint.close();
    await host.close();
  }
});
test("the Node inbox reads fragments without copying the full event out of the worker and stores one row", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-node-outbox-fragments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "host.db");
  seedOutbox(path, [0, 18]);
  const host = await BridgeHost.open({ path, policy, backend: localTestBackend() });
  const endpoint = await attachGateway(host, token);
  const inboxPath = join(root, "inbox.db");
  const inbox = new GatewayInbox(inboxPath);
  const workerReplies: unknown[] = [];
  const readEvents = host.events.bind(host);
  host.events = async (...args) => {
    const page = await readEvents(...args);
    const event = Array.isArray(page) ? page[0] : page.events?.[0];
    workerReplies.push(page.fragment
      ? { offset: page.fragment.offset, bytes: Buffer.byteLength(page.fragment.data, "base64") }
      : { fullBytes: event?.payload?.params?.text?.length ?? 0 });
    return page;
  };
  const offsets: number[] = [];
  endpoint.server.on("request", request => {
    const url = new URL(request.url!, endpoint.url);
    if (url.pathname === "/events" && url.searchParams.has("fragment"))
      offsets.push(Number(url.searchParams.get("fragment")));
  });
  try {
    // The producer can put the small event alone in its first response.
    assert.deepEqual((await inbox.pull(endpoint.url, token)).map(row => row.seq), [1]);
    assert.deepEqual(offsets, [0]);
    const [large] = await inbox.pull(endpoint.url, token);
    assert.equal(large?.seq, 2);
    assert.ok(offsets.some(offset => offset > 0), "the Node reader requested the remaining fragments");
    const total = Buffer.byteLength(JSON.stringify(large));
    assert.deepEqual(workerReplies.slice(1), offsets.slice(1).map(offset => ({
      offset, bytes: Math.min(BRIDGE_OUTBOX_FRAGMENT_BYTES, total - offset),
    })), "large fragment requests transfer only the fragment from the storage worker");
    assert.equal((await host.events(2, 256, true)).acknowledged, 2);
    assert.deepEqual((await inbox.read()).map(row => row.seq), [1], "leave an oversized row for its own replay page");
    assert.deepEqual(await inbox.read(1), [{ ...large, projection: [] }],
      "the next replay page contains the complete event and its stored projection");
    assert.deepEqual(await inbox.read(2), []);
    assert.equal(await inbox.cursor(), 2, "replay reads leave the durable cursor unchanged");
  } finally {
    await inbox.close();
    await endpoint.close();
    await host.close();
  }
  const database = new DatabaseSync(inboxPath, { readOnly: true });
  try {
    const rows = database.prepare("SELECT seq, length(json_extract(payload, '$.params.text')) AS size FROM inbox ORDER BY seq").all();
    assert.deepEqual(rows.map(row => [row.seq, row.size]), [[1, 0], [2, 18 * 1024 * 1024]]);
  } finally {
    database.close();
  }
});
test("history joins route identities across pending outbox pages and an acknowledgement race", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-history-identities-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "host.db");
  const published = resolveStoreMigrations("agent-bridge-host", migrations);
  const { database } = openManagedDatabase({ path, migrations: published.filter(({ version }) => version < 6) });
  const route = '["server-1","thread-1"]';
  const put = database.prepare("INSERT INTO outbox (route,generation,payload) VALUES (?,'g1',?)");
  for (let index = 0; index < 256; index++) put.run('["server-1","other"]', JSON.stringify({ method: "other" }));
  for (let index = 0; index < 256; index++) put.run(route, JSON.stringify({ kind: "canonical", event: {
    kind: "turn.started", nativeTurnId: `native-turn-${index}`, turnId: `public-turn-${index}`, atMs: 0,
  } }));
  put.run(route, JSON.stringify({ kind: "canonical", event: {
    kind: "item.completed", turnId: "public-turn-255", atMs: 1,
    item: { nativeKey: "native-item", itemId: "public-item", shape: { kind: "agentMessage", text: "ready" } },
  } }));
  database.close();

  const host = await BridgeHost.open({ path, policy, backend: localTestBackend() });
  const inbox = new GatewayInbox(join(root, "inbox.db"));
  const endpoint = await attachGateway(host, token);
  const raw = { data: [{ id: "native-turn-255", items: [{ id: "native-item" }] }, { id: "old-native-turn", items: [] }] };
  const expected = { data: [{ id: "public-turn-255", items: [{ id: "public-item" }] }, { id: "old-native-turn", items: [] }] };
  const observed: unknown[] = [];
  let identityPages = 0;
  let historyPulls = 0;
  const afters: number[] = [];
  const committedReads: number[][] = [];
  const gateway = new BridgeGatewaySession({
    serverId: "server-1",
    async request(path, body) {
      if (path === "/observe") {
        observed.push(body);
        return Response.json(raw);
      }
      const reply = await rpc(endpoint.url, path, body);
      if (path.split("?")[0] === "/snapshot") delete reply.historyIdentitySelection;
      if (path.startsWith("/history-identities?")) {
        afters.push(Number(new URL(path, endpoint.url).searchParams.get("after")));
        identityPages++;
      }
      if (path.startsWith("/history-identities?") && identityPages === 1) {
        assert.equal(reply.identities.length, 256);
        assert.equal(reply.acknowledged, 0);
        // Another attachment commits and acknowledges the tail between identity pages.
        for (let index = 0; index < 3; index++) await inbox.pull(endpoint.url, token);
      }
      return Response.json(reply);
    },
    inbox: {
      cursor: () => inbox.cursor(),
      read: after => inbox.read(after),
      readIdentities: (route, after, through) => {
        committedReads.push([after, through]);
        return inbox.readIdentities(route, after, through);
      },
      readPendingInteractions: (route, after, through, ids) => inbox.readPendingInteractions(route, after, through, ids),
      async pull() { historyPulls++; return inbox.pull(endpoint.url, token); },
      close: () => inbox.close(),
    },
  }, () => {});
  try {
    assert.equal((await host.snapshot()).databaseOutcome.status, "migrated");
    await gateway.open({ live: false });
    assert.deepEqual(await gateway.observe("thread-1", { limit: 2 }), expected);
    assert.equal(identityPages, 2);
    assert.equal(historyPulls, 0);
    committedReads.length = 0;
    assert.deepEqual(await gateway.observe("thread-1", { turnId: "public-turn-255" }), expected);
    assert.equal((observed.at(-1) as { params: { turnId: string } }).params.turnId, "native-turn-255");
    assert.equal(historyPulls, 0);
    assert.deepEqual(afters.slice(2), [0, 513], "project the reply using only identities added since target resolution");
    assert.deepEqual(committedReads, [[0, 513], [512, 513]], "read the acknowledged prefix only once");
  } finally {
    await gateway.close();
    await endpoint.close();
    await host.close();
  }

  const current = new DatabaseSync(path);
  const version = 6;
  current.prepare("UPDATE schema_migrations SET checksum='tampered' WHERE version=?").run(version);
  current.close();
  const broken = new Storage(path);
  try {
    await assert.rejects(broken.ready, /migration history/);
  } finally {
    await broken.close().catch(() => {});
  }
});

test("exact history reads include newly acknowledged items and reject a changed producer or rewind", async () => {
  const id = "1".repeat(32), replacement = "2".repeat(32);
  let nativeRead = false;
  let transition: "replace" | "rewind" | "advance" = "replace";
  const cursors: number[] = [];
  const inboxRanges: number[][] = [];
  const session = new BridgeGatewaySession({
    serverId: "server",
    async request(path, body) {
      if (path.split("?")[0] === "/snapshot") return Response.json({ historyIdentityPages: true, nativeSessions: [], routes: [], interactions: [] });
      if (path === "/observe") {
        assert.equal((body as { params: { turnId: string } }).params.turnId, "turn-native");
        nativeRead = true;
        return Response.json({ data: [{ turnId: "turn-native", item: { id: "new-native" } }] });
      }
      const url = new URL(path, "http://bridge.invalid");
      assert.equal(url.pathname, "/history-identities");
      cursors.push(Number(url.searchParams.get("after")));
      if (nativeRead && transition === "rewind")
        return Response.json({ outboxId: id, acknowledged: 0, high: 0, identities: [] });
      return Response.json(nativeRead
        ? { outboxId: transition === "replace" ? replacement : id, acknowledged: 2, high: 2, identities: [] }
        : { outboxId: id, acknowledged: 0, high: 1, identities: [{ seq: 1, turn: { nativeId: "turn-native", id: "turn-public" } }] });
    },
    inbox: {
      async cursor() { return nativeRead ? 2 : 0; },
      async readIdentities(_, after, through) {
        inboxRanges.push([after, through]);
        return [{ seq: 2, item: { nativeId: "new-native", id: "new-public" } }];
      },
      async readPendingInteractions() { return []; },
      async read() { return []; },
      async pull() { assert.fail("history must not pull the live inbox"); },
      async close() {},
    },
  }, () => assert.fail("history must not publish live events"));
  try {
    await session.open({ live: false });
    await assert.rejects(session.observe("thread", { turnId: "turn-public" }), /Invalid Bridge history identity fence/);
    nativeRead = false;
    transition = "rewind";
    await assert.rejects(session.observe("thread", { turnId: "turn-public" }), /Invalid Bridge history identity fence/);
    assert.deepEqual(inboxRanges, [], "a replacement producer cannot read the old request's prefix");
    nativeRead = false;
    transition = "advance";
    cursors.length = 0;
    assert.deepEqual(await session.observe("thread", { turnId: "turn-public" }),
      { data: [{ turnId: "turn-public", item: { id: "new-public" } }] });
    assert.deepEqual(cursors, [0, 1]);
    assert.deepEqual(inboxRanges, [[1, 2]]);
  } finally {
    await session.close();
  }
});

test("a Bridge history page transfers only the aliases for its returned Turns and items", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-history-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "host.db");
  const { database } = openManagedDatabase({ path, schemaId: "agent-bridge-host", migrations });
  const route = '["server","thread"]';
  const put = database.prepare("INSERT INTO outbox (route,generation,payload) VALUES (?,'g',?)");
  const turn = (nativeTurnId: string, turnId: string) => put.run(route, JSON.stringify({
    kind: "canonical", event: { kind: "turn.started", nativeTurnId, turnId },
  }));
  database.exec("BEGIN");
  turn("native-root", "public-root");
  for (let index = 0; index < 290; index++) turn(`unused-native-${index}`, `unused-public-${index}`);
  turn("native-turn", "public-turn");
  put.run(route, JSON.stringify({ kind: "canonical", event: { kind: "item.completed",
    item: { nativeKey: "native-item", itemId: "public-item" },
  } }));
  put.run('["server","peer"]', JSON.stringify({ kind: "canonical", event: {
    kind: "turn.started", nativeTurnId: "native-turn", turnId: "peer-turn",
  } }));
  database.exec("COMMIT");
  database.close();

  const host = await BridgeHost.open({ path, policy, backend: localTestBackend() });
  const endpoint = await attachGateway(host, token);
  const inbox = new GatewayInbox(join(root, "inbox.db"));
  const raw = { data: [{ id: "native-turn", rootTurnId: "native-root", items: [{ id: "native-item" }] }] };
  const expected = { data: [{ id: "public-turn", rootTurnId: "public-root", items: [{ id: "public-item" }] }] };
  let hostRows = 0, inboxRows = 0;
  let widePage = false;
  const extraItems = Array.from({ length: 1024 }, (_, index) => ({ id: `native-only-item-${index}` }));
  const session = new BridgeGatewaySession({
    serverId: "server",
    async request(path, body) {
      if (path === "/observe") {
        const requested = (body as { params: { turnId?: string } }).params.turnId;
        if (requested !== undefined) assert.equal(requested, "native-turn");
        return Response.json(widePage ? { data: [{ ...raw.data[0], items: [...raw.data[0]!.items, ...extraItems] }] } : raw);
      }
      const reply = await rpc(endpoint.url, path, body);
      if (path.startsWith("/history-identities")) hostRows += reply.identities.length;
      return Response.json(reply);
    },
    inbox: {
      cursor: () => inbox.cursor(),
      async readIdentities(...args) {
        const rows = await inbox.readIdentities(...args);
        inboxRows += rows.length;
        return rows;
      },
      readPendingInteractions: (...args) => inbox.readPendingInteractions(...args),
      async read() { assert.fail("history must not replay event payloads"); },
      async pull() { assert.fail("history must not advance the committed cursor"); },
      close: () => inbox.close(),
    },
  }, () => assert.fail("history must not publish live events"));
  try {
    assert.deepEqual((await inbox.pull(endpoint.url, token)).length, 256);
    await session.open({ live: false });
    assert.deepEqual(await session.observe("thread", { limit: 1 }), expected);
    assert.deepEqual([inboxRows, hostRows], [1, 2], "a one-Turn page excludes all unrelated IDs");
    inboxRows = hostRows = 0;
    assert.deepEqual(await session.observe("thread", { turnId: "public-turn" }), expected);
    assert.deepEqual([inboxRows, hostRows], [1, 3], "the exact Turn lookup adds only one mapping");
    widePage = true;
    assert.deepEqual(await session.observe("thread", { limit: 1 }), {
      data: [{ ...expected.data[0], items: [...expected.data[0]!.items, ...extraItems] }],
    }, "a page exceeding the selector budget keeps the full identity projection");
  } finally {
    await session.close();
    await endpoint.close();
    await host.close();
  }
});

test("selected history rejects a remapped public Turn even when the native reply is empty", async () => {
  const session = new BridgeGatewaySession({
    serverId: "server",
    async request(path, body) {
      if (path.split("?")[0] === "/snapshot") return Response.json({
        historyIdentityPages: true, historyIdentitySelection: true, routes: [], nativeSessions: [], interactions: [],
      });
      if (path === "/observe") return Response.json({ data: [] });
      assert.equal(path, "/history-identities");
      const { selection } = body as { selection: { nativeIds: string[]; publicTurnId?: string } };
      const identities = selection.publicTurnId ? [{ seq: 1, turn: { nativeId: "native", id: "retired" } }]
        : selection.nativeIds.includes("native") ? [{ seq: 2, turn: { nativeId: "native", id: "current" } }] : [];
      return Response.json({ outboxId: "1".repeat(32), acknowledged: 0, high: 2, identities });
    },
    inbox: {
      async cursor() { return 0; }, async read() { return []; }, async readIdentities() { return []; },
      async readPendingInteractions() { return []; }, async close() {},
      async pull() { assert.fail("history must not pull the live inbox"); },
    },
  }, () => assert.fail("history must not publish live events"));
  try {
    await session.open({ live: false });
    await assert.rejects(session.observe("thread", { turnId: "retired" }), /History Turn identity changed/);
  } finally {
    await session.close();
  }
});

function child(file: string, env: Record<string, string>): ChildProcess {
  return fork(resolve("tests/agent-bridge/fixtures/" + file), {
    execArgv: ["--import", "tsx"],
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}
async function stop(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exit = once(proc, "exit");
  proc.send("close");
  await exit;
}

test("durable admission, input digest and duplicate commandId do not resend native mutation", async (t) => {
  const { host, root } = await setup(t);
  assert.equal((await host.snapshot()).databaseOutcome.status, "fresh");
  const first = await host.accept(command("create"));
  assert.equal(first.state, "registered");
  assert.equal(first.epoch, 1);
  await accepted(host, "create");
  await host.accept(command("start", "turn/start"));
  await accepted(host, "start");
  await host.accept(command("start", "turn/start"));
  await assert.rejects(host.accept(command("start", "turn/start", { changed: true })), /different input/);
  assert.equal((await readFile(join(root, "executions"), "utf8")).trim().split("\n").length, 1);
});

test("real gateway process restart leaves independent Host/bridge PID and Turn running; durable projection has no duplicates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-process-"));
  const proc = child("host-process.ts", { TEST_DB: join(root, "host.db"), TEST_TOKEN: token });
  let gateway: ChildProcess | undefined;
  t.after(async () => {
    if (gateway) await stop(gateway);
    await stop(proc);
    await rm(root, { recursive: true, force: true });
  });
  const [descriptor] = await once(proc, "message");
  await rpc(descriptor.url, "/generation/add", await config(root, "g1", descriptor.pid));
  await rpc(descriptor.url, "/generation/activate", { id: "g1", expected: "" });
  await rpc(descriptor.url, "/command", command("create"));
  const created = await until(
    () => rpc(descriptor.url, "/command?id=create"),
    (r) => r.state === "accepted",
  );
  const bridgePid = created.response.result.pid;
  await rpc(descriptor.url, "/command", command("start", "turn/start", { hold: true }));
  await until(
    () => rpc(descriptor.url, "/command?id=start"),
    (r) => r.state === "accepted",
  );
  const env = { INBOX_DB: join(root, "gateway.db"), HOST_URL: descriptor.url, TEST_TOKEN: token };
  gateway = child("gateway-process.ts", env);
  await once(gateway, "message");
  let answer = once(gateway, "message");
  gateway.send("pull");
  const [first] = await answer;
  assert(first.events.length > 0);
  gateway.kill("SIGKILL");
  await once(gateway, "exit");
  assert(!first.events.some((e: any) => e.payload.event?.kind === "turn.completed"));
  await writeFile(join(root, "executions.release"), "release");
  await until(
    () => rpc(descriptor.url, "/events?cursor=" + first.events.at(-1).seq),
    (events) => events.some((e: any) => e.payload.event?.kind === "turn.completed"),
  );
  gateway = child("gateway-process.ts", env);
  await once(gateway, "message");
  answer = once(gateway, "message");
  gateway.send("pull");
  const [second] = await answer;
  assert(second.events.some((e: any) => e.payload.event?.kind === "turn.completed"));
  answer = once(gateway, "message");
  gateway.send("pull");
  const [third] = await answer;
  assert.deepEqual(third.events, []);
  assert.equal((await rpc(descriptor.url, "/health")).pid, descriptor.pid);
  process.kill(bridgePid, 0);
  const turns = [...first.events, ...second.events].filter((e: any) => e.payload.event?.kind.startsWith("turn."));
  assert(turns.every((e: any) => e.payload.event.atMs > Date.UTC(2020, 0, 1)));
  assert.equal(new Set(turns.map((e: any) => e.payload.event.turnId)).size, 1);
  assert.equal(
    new Set([...first.events, ...second.events].map((e: any) => e.seq)).size,
    first.events.length + second.events.length,
  );
  assert.equal((await readFile(join(root, "executions"), "utf8")).trim().split("\n").length, 1);
});

test("queue recovery settles only receipts for the matching attempt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-queue-refusal-recovery-"));
  const path = join(root, "host.db");
  let storage = new Storage(path, "host");
  t.after(async () => {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  await storage.ready;
  await storage.call("add", await config(root));
  await storage.call("activate", { id: "g1", expected: "" });
  const route = JSON.stringify(["server-1", "thread-1"]);
  const admit = (request: ReturnType<typeof command>) =>
    storage.call("admit", { command: request, route, digest: JSON.stringify(request), maxSpoolBytes: 1 << 20 });
  await admit(command("create"));
  await storage.call("dispatch", { id: "create" });
  await storage.call("settle", { id: "create", state: "accepted" });

  const cases = [
    { clientId: "start-not-sent", kind: "start", target: "unknown", queueState: "queued", admission: "rejected", paused: "delivery-rejected" },
    { clientId: "steer-not-sent", kind: "steer", target: "turn-id", queueState: "queued", admission: "rejected", paused: null },
    { clientId: "start-accepted", kind: "start", target: "unknown", queueState: "delivered", admission: "accepted", paused: null,
      result: { turn: { id: "new-turn" } }, recoveredTarget: "new-turn" },
    { clientId: "steer-accepted", kind: "steer", target: "turn-id", queueState: "steering", admission: "accepted", paused: null,
      result: { turnId: "turn-id" }, recoveredTarget: "turn-id" },
    { clientId: "steer-closed", kind: "steer", target: "completed-turn", queueState: "closed", admission: "accepted", paused: null,
      result: { turnId: "completed-turn" }, recoveredTarget: "completed-turn", terminal: true },
    { clientId: "steer-wrong-turn", kind: "steer", target: "turn-id", queueState: "unknown", admission: "unknown", paused: "steer-delivery-unconfirmed",
      result: { turnId: "different-turn" } },
    { clientId: "invalid-start-ack", kind: "start", target: "unknown", queueState: "unknown", admission: "unknown", paused: "steer-delivery-unconfirmed",
      result: { turn: { id: {} } } },
    { clientId: "refusal-already-saved", kind: "start", target: "unknown", queueState: "queued", admission: "rejected", paused: "delivery-rejected" },
    { clientId: "maybe-sent", kind: "start", target: "unknown", queueState: "unknown", admission: "unknown", paused: "steer-delivery-unconfirmed" },
    { clientId: "other-revision", kind: "start", target: "unknown", queueState: "unknown", admission: "unknown", paused: "steer-delivery-unconfirmed" },
  ];
  const commandIds = new Map<string, string>();
  for (const fixture of cases) {
    const row = await storage.call("queue", { method: "add", args: [route, fixture.clientId, [{ type: "text", text: fixture.clientId }]] });
    const claimed = await storage.call("queue", { method: "claim", args: [route, row.id, fixture.target] });
    const revision = claimed.delivery.revision + Number(fixture.clientId === "other-revision");
    const key = createHash("sha256").update(JSON.stringify([route, fixture.clientId, fixture.target, revision])).digest("hex");
    const id = "queue-" + fixture.kind + ":" + key;
    commandIds.set(fixture.clientId, id);
    await admit(command(id, "turn/" + fixture.kind));
    if (fixture.clientId === "maybe-sent" || fixture.result) await storage.call("dispatch", { id });
    if (fixture.clientId === "refusal-already-saved") await storage.call("settle", { id, state: "rejected" });
    if (fixture.terminal) await storage.call("queue", { method: "finishTurn", args: [route, fixture.target, "completed"] });
    if (fixture.result) await storage.call("settle", {
      id, state: "accepted", response: { jsonrpc: "2.0", id: "host-command:" + id, result: fixture.result },
    });
  }
  // The process stops with persisted queue claims and no queue settlement.
  await storage.close();
  storage = new Storage(path, "host");
  await storage.ready;
  for (const fixture of cases) {
    const recovered = await storage.call("queue", { method: "findByClientId", args: [route, fixture.clientId] });
    assert.equal(recovered.state, fixture.queueState, fixture.clientId);
    assert.equal(recovered.pausedReason, fixture.paused, fixture.clientId);
    assert.equal(recovered.delivery.nativeAdmission, fixture.admission, fixture.clientId);
    assert.equal(recovered.targetTurnId, fixture.queueState === "queued" ? null : fixture.recoveredTarget ?? fixture.target);
    if (fixture.terminal) assert.equal(recovered.delivery.execution, "completed");
    assert.equal(recovered.delivery.context, "unobserved");
    const receipt = await storage.call("query", { id: commandIds.get(fixture.clientId) });
    assert.equal(receipt.state, fixture.result ? "accepted" : fixture.clientId === "maybe-sent" ? "unknown" : "rejected");
  }
  const recoveredEvents = await storage.call<OutboxEvent[]>("events", { cursor: 0, limit: 10 });
  assert.deepEqual(recoveredEvents.map(({ route, generation, payload }) => ({ route, generation, payload })), [
    { route, generation: "g1", payload: { method: "thread/queue/changed", params: { threadId: route } } },
  ]);
  await storage.close();
  storage = new Storage(path, "host");
  await storage.ready;
  assert.deepEqual(await storage.call("events", { cursor: 0, limit: 10 }), recoveredEvents);
});

test("Bridge queue shares history within reconciliation and reads again after idle before retrying", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-queue-history-"));
  const storage = new Storage(join(root, "host.db"), "host");
  t.after(async () => {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  await storage.ready;
  const route = JSON.stringify(["server-1", "thread-1"]);
  await storage.call("add", await config(root));
  await storage.call("activate", { id: "g1", expected: "" });
  await storage.call("admit", { command: command("create"), route, digest: "create", maxSpoolBytes: 1 << 20 });
  await storage.call("dispatch", { id: "create" });
  await storage.call("settle", { id: "create", state: "accepted" });
  const store = (method: string, ...args: unknown[]) => storage.call("queue", { method, args: [route, ...args] });
  const historyReads: boolean[] = [];
  let idle = false;
  let retry = false;
  const queue = new HostQueue(storage, {
    command: async () => assert.fail("Reconciliation must not dispatch"),
    recover: async () => assert.fail("Queue list must not resume the provider"),
    dispatchable: async () => false,
    canReconcile: async () => true,
    isIdle: async () => {
      idle = retry;
      return idle;
    },
    history: async () => {
      historyReads.push(idle);
      return {
        thread: {
          turns: [
            { id: "first", status: "inProgress", items: [
              { type: "userMessage", clientId: "seen-first" },
              { type: "userMessage", clientId: "other-turn" },
              { type: "agentMessage", clientId: "missing" },
            ] },
            { id: "second", status: idle ? "completed" : "inProgress", items: [
              { type: "userMessage", clientId: "seen-second" },
              ...(idle ? [{ type: "userMessage", clientId: "late" }] : []),
            ] },
          ],
        },
      };
    },
  });
  t.after(() => queue.close());

  const stage = async (clientId: string, turnId: string) => {
    const row = await store("add", clientId, [{ type: "text", text: clientId }]);
    await store("claim", row.id, turnId);
    await store("settle", row.id, "unknown");
    return row.id;
  };
  const first = await stage("seen-first", "first");
  const second = await stage("seen-second", "second");
  const missing = await stage("missing", "first");
  await queue.request(route, "thread/queue/list", { receiptTurnIds: ["first"] });
  await until(() => store("find", second), row => row.state === "delivered");
  assert.deepEqual(historyReads, [false]);
  assert.equal((await store("find", first)).delivery.context, "recorded");
  assert.equal((await store("find", second)).delivery.context, "recorded");
  assert.equal((await store("find", missing)).state, "unknown");
  await store("discardUnknown", missing, "first");

  const late = await stage("late", "second");
  await store("requestRetry", late, "second");
  retry = true;
  historyReads.length = 0;
  await queue.request(route, "thread/queue/list", { receiptTurnIds: ["second"] });
  await until(() => store("find", late), row => row.state === "delivered");
  assert.deepEqual(historyReads, [false, true]);
  assert.equal((await store("find", late)).delivery.context, "recorded");

  const ended = await stage("other-turn", "second");
  const alsoEnded = await stage("unobserved", "second");
  idle = false;
  historyReads.length = 0;
  await queue.request(route, "thread/queue/list", { receiptTurnIds: [] });
  await until(() => store("find", alsoEnded), row => row.state === "closed");
  assert.deepEqual(historyReads, [false, true]);
  for (const id of [ended, alsoEnded]) {
    const recovered = await store("find", id);
    assert.equal(recovered.state, "closed");
    assert.equal(recovered.delivery.execution, "completed");
    assert.equal(recovered.delivery.context, "unobserved");
  }
});

test("Bridge queue reads durable rows while provider history and the live outbox are held", { timeout: 6000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-queue-passive-list-"));
  const storage = new Storage(join(root, "host.db"), "host");
  const history = Promise.withResolvers<unknown>();
  const enteredHistory = Promise.withResolvers<void>();
  const live = Promise.withResolvers<OutboxEvent[]>();
  const route = JSON.stringify(["server-1", "thread-1"]);
  const errors: Record<string, unknown>[] = [];
  let historyReads = 0;
  let outboxReads = 0;
  const notifications: unknown[] = [];
  const queue = new HostQueue(storage, {
    command: async () => assert.fail("Listing cannot dispatch"),
    recover: async () => assert.fail("Listing cannot resume the provider"),
    dispatchable: async () => false,
    canReconcile: async () => true,
    isIdle: async () => false,
    history: async () => {
      historyReads++;
      if (historyReads > 1) return { thread: { turns: [{ id: "native-turn", items: [{ type: "userMessage", clientId: "unknown" }] }] } };
      enteredHistory.resolve();
      return history.promise;
    },
  }, entry => errors.push(entry));
  const session = new BridgeGatewaySession({
    serverId: "server-1",
    async request(path, body) {
      assert.equal(path, "/queue");
      const { method, params } = body as { method: string; params: Record<string, unknown> };
      return Response.json(await queue.request(route, method, params));
    },
    inbox: {
      cursor: async () => 0,
      read: (cursor = 0) => storage.call<OutboxEvent[]>("events", { cursor, limit: 10 }),
      readIdentities: async () => [],
      readPendingInteractions: async () => [],
      pull: () => { outboxReads++; return live.promise; },
      close: async () => {},
    },
  }, (_threadId, event) => notifications.push(event));
  t.after(async () => {
    queue.close();
    history.resolve({ thread: { turns: [] } });
    live.resolve([]);
    await session.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  await storage.ready;
  await storage.call("add", await config(root));
  await storage.call("activate", { id: "g1", expected: "" });
  await storage.call("admit", { command: command("create"), route, digest: "create", maxSpoolBytes: 1 << 20 });
  await storage.call("dispatch", { id: "create" });
  await storage.call("settle", { id: "create", state: "accepted" });
  const store = (method: string, ...args: unknown[]) => storage.call("queue", { method, args: [route, ...args] });
  const old = await store("add", "unknown", [{ type: "text", text: "old" }]);
  await store("claim", old.id, "native-turn");
  await store("settle", old.id, "unknown");
  await store("add", "waiting", [{ type: "text", text: "new" }]);

  const before = session.pull();
  const list = () => session.queue("thread-1", "thread/queue/list", { receiptTurnIds: ["native-turn"] }) as Promise<{
    data: { clientUserMessageId: string }[];
    steering: { clientUserMessageId: string }[];
  }>;
  const first = list();
  await enteredHistory.promise;
  const result = await first;
  assert.deepEqual(result.data.map(row => row.clientUserMessageId), ["waiting"]);
  assert.deepEqual(result.steering.map(row => row.clientUserMessageId), ["unknown"]);
  assert.deepEqual(await list(), result);
  assert.equal(historyReads, 1);
  assert.equal(outboxReads, 1);

  history.reject(Error("Fixture history unavailable"));
  await until(() => errors.length, count => count === 1);
  assert.equal((await store("find", old.id)).state, "unknown");
  await list();
  await until(() => store("find", old.id), row => row.state === "delivered");
  assert.equal(historyReads, 2);
  assert.deepEqual((await list()).steering, []);
  live.resolve([]);
  await before;
  assert.deepEqual(notifications, [{ method: "thread/queue/changed", params: { threadId: "thread-1" } }]);
});

test("Bridge queue scopes closed receipts by public Turn before the live inbox catches up", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-queue-receipt-scope-"));
  const path = join(root, "host.db");
  const storage = new Storage(path, "host");
  const route = JSON.stringify(["server-1", "thread-1"]);
  await storage.ready;
  try {
    await storage.call("add", await config(root));
    await storage.call("activate", { id: "g1", expected: "" });
    await storage.call("admit", { command: command("create"), route, digest: "create", maxSpoolBytes: 1 << 20 });
    await storage.call("dispatch", { id: "create" });
    await storage.call("settle", { id: "create", state: "accepted" });
    const store = (method: string, ...args: unknown[]) => storage.call("queue", { method, args: [route, ...args] });
    for (const nativeTurnId of ["native-first", "native-second", "native-hidden", "legacy-native-only"]) {
      const row = await store("add", nativeTurnId, [{ type: "text", text: "queued" }]);
      await store("claim", row.id, nativeTurnId);
      await store("settle", row.id, "steering");
      await store("finishTurn", nativeTurnId, "completed");
      if (nativeTurnId === "legacy-native-only") continue;
      await storage.call("callback", {
        id: nativeTurnId, generation: "g1", method: "thread/delta", params: {
          threadId: route, deltas: [
            { op: "turn.open", nativeTurnId, scope: { threadId: route } },
            { op: "turn.close", nativeTurnId, status: "completed", scope: { threadId: route } },
          ],
        },
      });
    }
  } finally {
    await storage.close();
  }

  const host = await BridgeHost.open({ path, policy, backend: localTestBackend() });
  const endpoint = await attachGateway(host, token);
  const selected: unknown[] = [];
  const gateway = new BridgeGatewaySession({
    serverId: "server-1",
    async request(path, body) {
      if (path === "/history-identities") selected.push((body as { selection: unknown }).selection);
      return Response.json(await rpc(endpoint.url, path, body));
    },
    inbox: {
      cursor: async () => 0, read: async () => [], readIdentities: async () => [],
      readPendingInteractions: async () => [],
      pull: async () => assert.fail("A scoped queue list must not wait for the live outbox"),
      close: async () => {},
    },
  }, () => assert.fail("Listing does not replay live notifications"));
  t.after(async () => {
    await gateway.close();
    await endpoint.close();
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  await gateway.open({ live: false });
  const list = (receiptTurnIds: unknown[]) => gateway.queue("thread-1", "thread/queue/list", { receiptTurnIds }) as Promise<{
    steering: { targetTurnId: string; clientUserMessageId: string; delivery: { targetTurnId: string; execution: string } }[];
  }>;
  const result = await list(["t1.2", "legacy-native-only", "t1.1", "t1.2"]);
  assert.deepEqual(result.steering.map(row => [
    row.clientUserMessageId, row.targetTurnId, row.delivery.targetTurnId, row.delivery.execution,
  ]), [
    ["native-first", "t1.1", "t1.1", "completed"],
    ["native-second", "t1.2", "t1.2", "completed"],
    ["legacy-native-only", "legacy-native-only", "legacy-native-only", "completed"],
  ]);
  assert.deepEqual(selected, [{ nativeIds: [], publicTurnIds: ["t1.2", "legacy-native-only", "t1.1"] }]);
  assert.deepEqual((await list([])).steering, []);
});

test("Bridge queue transfers only the requested page and evidence rows from its storage worker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-queue-sql-page-"));
  const storage = new Storage(join(root, "host.db"), "host");
  const queue = new HostQueue(storage, {
    command: async () => assert.fail("Listing cannot dispatch"),
    recover: async () => assert.fail("Listing cannot resume execution"),
    dispatchable: async () => false,
    canReconcile: async () => true,
    isIdle: async () => false,
    history: async () => ({ thread: { turns: [] } }),
  });
  t.after(async () => {
    queue.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  await storage.ready;
  const route = JSON.stringify(["server-1", "thread-1"]);
  await storage.call("add", await config(root));
  await storage.call("activate", { id: "g1", expected: "" });
  await storage.call("admit", { command: command("create"), route, digest: "create", maxSpoolBytes: 1 << 20 });
  await storage.call("dispatch", { id: "create" });
  await storage.call("settle", { id: "create", state: "accepted" });
  const store = (method: string, ...args: unknown[]) => storage.call("queue", { method, args: [route, ...args] });
  for (const [clientId, turnId] of [["included", "included-turn"], ["excluded", "excluded-turn"], ["uncertain", "uncertain-turn"]]) {
    const row = await store("add", clientId, [{ type: "text", text: clientId }]);
    await store("claim", row.id, turnId);
    await store("settle", row.id, clientId === "uncertain" ? "unknown" : "steering");
    if (clientId !== "uncertain") await store("finishTurn", turnId, "completed");
  }
  for (let index = 0; index < 30; index++)
    await store("add", "pending-" + index, [{ type: "text", text: "x".repeat(4096) }]);

  const worker = storage.call.bind(storage);
  const transfers: { method: string; rows: number }[] = [];
  storage.call = async <T>(op: string, params?: unknown): Promise<T> => {
    const result = await worker<T>(op, params);
    if (op === "queue") {
      const { method } = params as { method: string };
      const page = result as { queued?: unknown[]; receipts?: unknown[] };
      if (method === "listReconciliation")
        assert.ok(Array.isArray(result) && result.every(row => !Object.hasOwn(row, "input")));
      transfers.push({ method, rows: Array.isArray(result) ? result.length : (page.queued?.length ?? 0) + (page.receipts?.length ?? 0) });
    }
    return result;
  };
  const list = (cursor: string | null) => queue.request(route, "thread/queue/list", {
    cursor, limit: 2, receiptTurnIds: ["included-turn"],
  }) as Promise<{
    data: { clientUserMessageId: string }[];
    steering?: { clientUserMessageId: string }[];
    nextCursor: string | null;
  }>;
  const first = await list(null);
  assert.deepEqual(first.data.map(row => row.clientUserMessageId), ["pending-0", "pending-1"]);
  assert.deepEqual(first.steering?.map(row => row.clientUserMessageId), ["included", "uncertain"]);
  assert.equal(first.nextCursor, "2");
  const last = await list("28");
  assert.deepEqual(last.data.map(row => row.clientUserMessageId), ["pending-28", "pending-29"]);
  assert.equal(last.nextCursor, null);
  assert.equal(last.steering, undefined);
  await until(() => transfers.length, count => count >= 3);
  assert.deepEqual(transfers.sort((a, b) => a.rows - b.rows).map(transfer => transfer.rows), [2, 2, 4],
    "the worker returns two pending pages and a receipt-only reconciliation");
});

for (const refusal of ["spool", "size"] as const) {
  test("a queue dispatch refused before Host admission keeps unsent custody: " + refusal, async (t) => {
    const { host, root } = await setup(t, refusal === "spool" ? 1 : undefined);
    await host.accept(command("create"));
    await accepted(host, "create");
    await until(() => host.events(0), rows => rows.length > 0);
    const queue = (method: string, params: Record<string, unknown>) =>
      host.queueRequest({ serverId: "server-1", threadId: "thread-1", method, params });
    await queue("thread/queue/add", {
      clientUserMessageId: "pending",
      input: [{ type: "text", text: refusal === "size" ? "x".repeat(BRIDGE_MAX_COMMAND_BYTES) : "Hello" }],
    });
    const retained = await until(
      () => queue("thread/queue/find", { clientUserMessageId: "pending" }) as Promise<any>,
      result => ["unknown", "rejected"].includes(result.queuedSubmission.delivery.nativeAdmission),
    );
    assert.equal(retained.queuedSubmission.state, "queued");
    assert.equal(retained.queuedSubmission.targetTurnId, null);
    assert.equal(retained.queuedSubmission.delivery.nativeAdmission, "rejected");
    const page = await queue("thread/queue/list", { receiptTurnIds: [] }) as { data: { pausedReason: string }[] };
    assert.equal(page.data[0]?.pausedReason, "delivery-rejected");
    assert.deepEqual(await host.maintenance(), { queued: 1, unknown: 0, inFlight: 0 });
    await assert.rejects(readFile(join(root, "executions")), { code: "ENOENT" });
  });
}

test("archived Bridge queues stay dormant across restart and resume on confirmed unarchive", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-archived-queue-"));
  const path = join(root, "host.db"), executions = join(root, "executions"), reads = join(root, "history-reads");
  await writeFile(executions, "");
  await writeFile(reads, "");
  const fixture = await config(root);
  const artifact = resolve("tests/agent-bridge/fixtures/queue-bridge.mjs");
  const provider = {
    ...fixture.provider,
    capabilities: { ...fixture.provider.capabilities, history: true, lifecycle: true, adoption: true },
  };
  const handshake = negotiateHandshake({ protocolVersion: 1, grammarRange: { min: 1, max: 1 } }, provider);
  assert(handshake.ok);
  const open = () => BridgeHost.open({ path, policy, backend: localTestBackend() });
  let host = await open();
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  await host.add({
    ...fixture, provider, artifact, digest: createHash("sha256").update(await readFile(artifact)).digest("hex"),
    launch: { cwd: root, command: [process.execPath, artifact],
      env: { EXECUTIONS: executions, HISTORY_READS: reads, HANDSHAKE: JSON.stringify(handshake.result) } },
  });
  await host.activate("g1", "");
  await host.accept(command("create"));
  await accepted(host, "create");

  // A closed receipt remains visible for this history scope, and is not a pending delivery.
  const route = JSON.stringify(["server-1", "thread-1"]);
  const storage = (host as unknown as { storage: Storage }).storage;
  const closed = await storage.call("queue", { method: "add", args: [route, "previous", [{ type: "text", text: "old" }]] });
  await storage.call("queue", { method: "claim", args: [route, closed.id, "closed-turn"] });
  await storage.call("queue", { method: "settle", args: [route, closed.id, "steering"] });
  await storage.call("queue", { method: "finishTurn", args: [route, "closed-turn", "completed"] });

  await host.accept(command("archive", "session/archive"));
  await accepted(host, "archive");
  await assert.rejects(host.accept(command("archived-send", "turn/start")), { kind: "invalid", message: /archive/i });
  const queue = (method: string, params: Record<string, unknown> = {}) =>
    host.queueRequest({ serverId: "server-1", threadId: "thread-1", method, params });
  await queue("thread/queue/add", { clientUserMessageId: "waiting", input: [{ type: "text", text: "new" }] });
  await host.close();
  host = await open();
  const listed = await queue("thread/queue/list", { receiptTurnIds: ["closed-turn"] }) as {
    data: { id: string; clientUserMessageId: string }[];
    steering: { clientUserMessageId: string }[];
  };
  assert.deepEqual(listed.data.map(row => row.clientUserMessageId), ["waiting"]);
  assert.deepEqual(listed.steering.map(row => row.clientUserMessageId), ["previous"]);
  await assert.rejects(queue("thread/queue/start", { queuedSubmissionId: listed.data[0]!.id }));
  assert.equal(await readFile(reads, "utf8"), "", "startup and queue reconciliation must not read archived history");
  assert.equal(await readFile(executions, "utf8"), "", "no queued input reached the archived provider");
  const observe = (params: Record<string, unknown>) =>
    host.observe({ serverId: "server-1", threadId: "thread-1", method: "history/read", params });
  for (const params of [
    { view: "thread", includeTurns: true }, { limit: 1 }, { view: "items" }, { view: "occurrences" },
  ]) {
    await assert.rejects(observe(params), { code: -32071 });
  }
  assert.equal(await readFile(reads, "utf8"), "", "ordinary history does not reach the archived provider");
  await observe({ view: "thread", includeTurns: false });
  await observe({ view: "thread", includeTurns: true, openArchivedHistory: true });
  assert.equal(await readFile(reads, "utf8"), (route + "\n").repeat(2));

  await host.accept(command("unarchive", "session/unarchive"));
  await accepted(host, "unarchive");
  const sent = await until(() => readFile(executions, "utf8"), value => value.includes("waiting"));
  assert.equal(sent.split("\n").filter(line => line === "waiting").length, 1);
});

test("Bridge archive upgrade preserves queued inputs and fences legacy or interrupted archive commands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-archive-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "host.db");
  const v7 = resolveStoreMigrations("agent-bridge-host", migrations).filter(({ version }) => version <= 7);
  const { database } = openManagedDatabase({ path, migrations: v7 });
  database.prepare("INSERT INTO generations (id,config) VALUES (?,?)").run("g1", JSON.stringify(await config(root)));
  const route = (id: string) => JSON.stringify(["server-1", id]);
  const old = [
    { id: "archived", commands: [["session/archive", "accepted"]], active: false },
    { id: "reopened", commands: [["session/archive", "accepted"], ["session/unarchive", "accepted"]], active: true },
    { id: "unconfirmed", commands: [["session/archive", "dispatching"]], active: false },
  ];
  for (const fixture of old) {
    database.prepare("INSERT INTO routes (route,generation) VALUES (?,'g1')").run(route(fixture.id));
    const insert = database.prepare("INSERT INTO commands(id,digest,epoch,route,generation,method,state) VALUES (?,? ,1,?,'g1',?,?)");
    for (const [index, [method, state]] of fixture.commands.entries()) {
      const id = fixture.id + "-" + index;
      insert.run(id, id, route(fixture.id), method!, state!);
    }
  }
  database.prepare(`INSERT INTO opencraft_host_queue (id,thread_id,client_id,input_json,position,created_at_ms,updated_at_ms,state)
    VALUES ('waiting',?,'client','[{"type":"text","text":"still here"}]',1,1,1,'queued')`).run(route("archived"));
  database.close();

  let store = new Storage(path, "host");
  try {
    assert.equal((await store.ready).status, "migrated");
    for (const fixture of old) {
      const state = await store.call("observationRoute", { route: route(fixture.id), forQueue: true });
      assert.equal(state.queueActive, fixture.active, fixture.id);
    }
    const retained = await store.call("queue", { method: "find", args: [route("archived"), "waiting"] });
    assert.deepEqual(retained.input, [{ type: "text", text: "still here" }]);
    const archive = command("new-archive", "session/archive", {}, "reopened");
    await store.call("admit", { command: archive, route: route("reopened"), digest: "new-archive", maxSpoolBytes: 1 << 20 });
    assert.equal((await store.call("observationRoute", { route: route("reopened"), forQueue: true })).queueActive, false,
      "archive admission immediately fences the queue");
    await store.call("dispatch", { id: "new-archive" });
    await store.close();

    store = new Storage(path, "host");
    await store.ready;
    assert.equal((await store.call("query", { id: "new-archive" })).state, "unknown");
    assert.equal((await store.call("observationRoute", { route: route("reopened"), forQueue: true })).queueActive, false);
  } finally {
    await store.close();
  }
  const tamper = new DatabaseSync(path);
  tamper.exec("UPDATE schema_migrations SET checksum='tampered' WHERE version=8");
  tamper.close();
  const broken = new Storage(path, "host");
  await assert.rejects(broken.ready, /migration history/);
  await broken.close().catch(() => {});
});

test("Host SIGKILL during CLI issuance recovers a definite refusal without native dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-crash-before-cli-issue-"));
  const marker = join(root, "cli-issue");
  const environment = { TEST_DB: join(root, "host.db"), TEST_TOKEN: token, TEST_CLI_ISSUE_MARKER: marker };
  let proc = child("host-process.ts", environment);
  let nativePid: number | undefined;
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) await stop(proc);
    if (nativePid) {
      try { process.kill(-nativePid, "SIGKILL"); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  });
  let [descriptor] = await once(proc, "message");
  await rpc(descriptor.url, "/generation/add", await config(root, "g1", descriptor.pid, true));
  await rpc(descriptor.url, "/generation/activate", { id: "g1", expected: "" });
  await rpc(descriptor.url, "/command", command("create"));
  nativePid = (await until(
    () => rpc(descriptor.url, "/command?id=create"),
    r => r.state === "accepted",
  )).response.result.pid;
  const start = command("preparing", "turn/start", { executionSource: "source" });
  await rpc(descriptor.url, "/command", start);
  await until(() => readFile(marker, "utf8").catch(() => ""), text => text === "waiting");
  const exited = once(proc, "exit");
  assert.equal(proc.kill("SIGKILL"), true);
  await exited;

  proc = child("host-process.ts", environment);
  [descriptor] = await once(proc, "message");
  const recovered = await rpc(descriptor.url, "/command?id=preparing");
  assert.equal(recovered.state, "rejected");
  assert.equal(recovered.epoch, 1);
  assert.equal(recovered.response.error.kind, "explicit-reject");
  assert.equal((await rpc(descriptor.url, "/command", start)).state, "rejected");
  await assert.rejects(readFile(join(root, "executions")), { code: "ENOENT" });
});

test("Host SIGKILL after native send recovers unknown and never performs second native execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-crash-"));
  let proc = child("host-process.ts", { TEST_DB: join(root, "host.db"), TEST_TOKEN: token });
  let nativePid: number | undefined;
  t.after(async () => {
    await stop(proc);
    if (nativePid) {
      try {
        process.kill(-nativePid, "SIGKILL");
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  });
  let [descriptor] = await once(proc, "message");
  await rpc(descriptor.url, "/generation/add", await config(root, "g1", descriptor.pid));
  await rpc(descriptor.url, "/generation/activate", { id: "g1", expected: "" });
  await rpc(descriptor.url, "/command", command("create"));
  nativePid = (
    await until(
      () => rpc(descriptor.url, "/command?id=create"),
      (r) => r.state === "accepted",
    )
  ).response.result.pid;
  const exit = once(proc, "exit");
  // It may die after admission response or while the response is in flight.
  await rpc(descriptor.url, "/command", command("crash", "turn/start", { crashWindow: true })).catch(() => {});
  await exit;
  proc = child("host-process.ts", { TEST_DB: join(root, "host.db"), TEST_TOKEN: token });
  [descriptor] = await once(proc, "message");
  const recovered = await rpc(descriptor.url, "/command?id=crash");
  assert.equal(recovered.state, "unknown");
  assert.equal(recovered.epoch, 1);
  const duplicate = await rpc(descriptor.url, "/command", command("crash", "turn/start", { crashWindow: true }));
  assert.equal(duplicate.state, "unknown");
  await delay(200);
  assert.equal((await readFile(join(root, "executions"), "utf8")).trim().split("\n").length, 1);
});

test("generation activation pins old threads and refuses retirement until native work and outbox drain", async (t) => {
  const { host, root } = await setup(t);
  await host.accept(command("create"));
  await accepted(host, "create");
  await host.add(await config(root, "g2"));
  await host.activate("g2", "g1");
  await assert.rejects(host.activate("g1", "g1"), /Stale/);
  await host.accept(command("new", "session/create", {}, "thread-2"));
  await accepted(host, "new");
  assert.equal((await host.query("new"))?.generation, "g2");
  await host.accept(command("old-start", "turn/start"));
  await accepted(host, "old-start");
  assert.equal((await host.query("old-start"))?.generation, "g1");
  await assert.rejects(host.retire("g1"), /bindings/);
  await assert.rejects(host.releaseThread("server-1", "thread-1"), /work/);
  await delay(1800);
  await host.accept(command("close", "session/close"));
  await accepted(host, "close");
  await assert.rejects(host.releaseThread("server-1", "thread-1"), /unacknowledged/);
  const events = await host.events(0);
  await host.ack(events.at(-1).seq);
  assert((await host.snapshot()).nativeSessions.some((row: any) => row.native_id.startsWith("native-")));
  await host.releaseThread("server-1", "thread-1");
  await host.retire("g1");
  await assert.rejects(host.accept(command("rebind-old")), /permanently closed/);
});

test("storage lock wait leaves network heartbeat and timers responsive; shutdown drains accepted writes", async (t) => {
  const { host, root } = await setup(t);
  const gateway = await attachGateway(host, token);
  t.after(() => gateway.close());
  const lock = new DatabaseSync(join(root, "host.db"));
  lock.exec("BEGIN IMMEDIATE");
  let beats = 0;
  const timer = setInterval(() => beats++, 10);
  const admission = host.accept(command("blocked"));
  let settled = false;
  void admission.then(() => {
    settled = true;
  });
  await delay(150);
  assert.equal(settled, false);
  assert(beats >= 8);
  assert.equal((await rpc(gateway.url, "/health")).pid, process.pid);
  lock.exec("ROLLBACK");
  lock.close();
  clearInterval(timer);
  assert.equal((await admission).state, "registered");
  await accepted(host, "blocked");
});

test("spool overflow refuses new tasks while preserving all active task events", async (t) => {
  const { host } = await setup(t, 1);
  await host.accept(command("create"));
  await accepted(host, "create");
  await host.ack((await host.events(0)).at(-1).seq);
  await host.accept(command("start", "turn/start"));
  await accepted(host, "start");
  await delay(1800);
  await assert.rejects(host.accept(command("new", "session/create", {}, "thread-2")), /Spool full/);
  await host.accept(command("stop-when-full", "turn/stop"));
  await accepted(host, "stop-when-full");
  const events = await host.events(1);
  assert(JSON.stringify(events).includes("15,"));
  assert(events.some((e: any) => e.payload.event?.kind === "turn.completed"));
});

test("v1 migration preserves admission on upgrade and checksum mismatch refuses startup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "host.db");
  let { database } = openManagedDatabase({ path, migrations: migrations.slice(0, 1) });
  database.exec("INSERT INTO commands VALUES ('original','digest',4,'route','g','turn/start','dispatching',NULL)");
  database.close();
  const store = new Storage(path);
  assert.equal((await store.ready).status, "migrated");
  assert.equal((await store.call("query", { id: "original" })).state, "unknown");
  await store.close();
  database = new DatabaseSync(path);
  database.exec("UPDATE schema_migrations SET checksum='tampered' WHERE version=1");
  database.close();
  const broken = new Storage(path);
  await assert.rejects(broken.ready, /migration history/);
  await broken.close().catch(() => {});
});

test("durable inbox transaction deduplicates replay including ack-loss and rejects gaps", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-inbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = new GatewayInbox(join(root, "inbox.db"));
  await inbox.storage.ready;
  const event = { seq: 1, route: "route", generation: "g", payload: { text: "one" } };
  assert.equal((await inbox.storage.call("inbox", { batch: [event] })).inserted.length, 1);
  await inbox.close();
  const reopened = new GatewayInbox(join(root, "inbox.db"));
  await reopened.storage.ready;
  assert.deepEqual((await reopened.storage.call("inbox", { batch: [event] })).inserted, []);
  const next = { ...event, seq: 2, payload: { text: "two" } };
  await assert.rejects(reopened.storage.call("inbox", { batch: [next, { ...event, seq: 4 }] }), /gap/);
  await assert.rejects(
    reopened.storage.call("inbox", { batch: [next, { ...event, generation: "other" }] }),
    /Conflicting replay/,
  );
  assert.equal(await reopened.storage.call("cursor"), 1);
  assert.deepEqual(await reopened.read(1), []);
  assert.deepEqual((await reopened.storage.call("inbox", { batch: [event, next] })).inserted, [next]);
  assert.deepEqual((await reopened.read()).map(({ seq }) => seq), [1, 2]);
  await reopened.close();
});

test("a transient producer read drains an already committed inbox page exactly once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-committed-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = new GatewayInbox(join(root, "inbox.db"));
  const route = '["server","thread"]';
  const append = (seq: number) => inbox.storage.call("inbox", { batch: [{
    seq, route, generation: "g", payload: { method: "thread/name/updated", params: { threadName: "name-" + seq } },
  }] });
  let status = 503;
  const request = async (path: string) => {
    if (path.split("?")[0] === "/snapshot") return Response.json({ routes: [], nativeSessions: [], interactions: [] });
    if (path === "/ack") return Response.json(null);
    return status === 200 ? Response.json([]) : new Response(null, { status });
  };
  const titles: string[] = [];
  const session = new BridgeGatewaySession({
    serverId: "server",
    request,
    inbox: {
      cursor: () => inbox.cursor(),
      read: cursor => inbox.read(cursor),
      readIdentities: (route, after, through) => inbox.readIdentities(route, after, through),
      readPendingInteractions: (route, after, through, ids) => inbox.readPendingInteractions(route, after, through, ids),
      pull: () => pullBridgeInbox(request, {
        cursor: () => inbox.cursor(), apply: batch => inbox.storage.call("inbox", { batch }),
      }),
      close: () => inbox.close(),
    },
  }, (_, frame) => titles.push((frame as { params: { threadName: string } }).params.threadName));
  try {
    await session.open({ live: false });
    await append(1);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(session.pull(), { status: 503 });
      assert.deepEqual(titles, ["name-1"]);
    }
    await append(2);
    status = 409;
    await assert.rejects(session.pull(), { status: 409 });
    assert.deepEqual(titles, ["name-1"]);
    status = 200;
    await session.pull();
    assert.deepEqual(titles, ["name-1", "name-2"]);
  } finally { await session.close(); }
});

test("an older interaction snapshot cannot prune a concurrently committed request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-interaction-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = new GatewayInbox(join(root, "inbox.db"));
  const route = '["server","thread"]', id = "pending";
  const snapshot = (interactions: { route: string; id: string }[]) => Response.json({
    routes: [], nativeSessions: [], interactions,
  });
  const held = Promise.withResolvers<Response>();
  const entered = Promise.withResolvers<void>();
  const heldActive = Promise.withResolvers<Response>();
  const enteredActive = Promise.withResolvers<void>();
  let snapshots = 0;
  const session = new BridgeGatewaySession({
    serverId: "server",
    async request(path) {
      assert.equal(path.split("?")[0], "/snapshot");
      if (++snapshots === 1) return snapshot([]);
      if (snapshots === 2) {
        entered.resolve();
        return held.promise;
      }
      if (snapshots === 4) {
        enteredActive.resolve();
        return heldActive.promise;
      }
      return snapshot([{ route, id }]);
    },
    inbox: {
      cursor: () => inbox.cursor(),
      read: cursor => inbox.read(cursor),
      readIdentities: (scope, after, through) => inbox.readIdentities(scope, after, through),
      readPendingInteractions: (scope, after, through, ids) => inbox.readPendingInteractions(scope, after, through, ids),
      async pull() {},
      close: () => inbox.close(),
    },
  }, () => {});
  try {
    await session.open({ live: false });
    const older = session.pendingInteractions("thread");
    await entered.promise;
    const payload = { method: "interaction/request", params: { interactionId: id } };
    await inbox.storage.call("inbox", { batch: [{ seq: 1, route, generation: "g", payload }] });
    await session.pull();
    held.resolve(snapshot([]));
    assert.deepEqual(await older, []);
    const restored = await session.pendingInteractions("thread");
    assert.deepEqual(restored, [{ ...payload, params: { ...payload.params, threadId: "thread" } }]);

    const outdatedActive = session.pendingInteractions("thread");
    await enteredActive.promise;
    await inbox.storage.call("inbox", { batch: [{
      seq: 2, route, generation: "g", payload: { ...payload, method: "interaction/resolved" },
    }] });
    await session.pull();
    heldActive.resolve(snapshot([{ route, id }]));
    assert.deepEqual(await outdatedActive, []);
  } finally {
    held.resolve(snapshot([]));
    heldActive.resolve(snapshot([]));
    await session.close();
  }
});

test("a committed approval can be restored while outbox reads are temporarily unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-committed-approval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = new GatewayInbox(join(root, "inbox.db"));
  const route = '["server","thread"]', id = "retained";
  const payload = { method: "interaction/request", params: { interactionId: id } };
  const interactions = [{ route, id }];
  let status = 503;
  const session = new BridgeGatewaySession({
    serverId: "server",
    async request(path) {
      assert.equal(path.split("?")[0], "/snapshot");
      return Response.json({ routes: [], nativeSessions: [], interactions });
    },
    inbox: {
      cursor: () => inbox.cursor(),
      read: cursor => inbox.read(cursor),
      readIdentities: (scope, after, through) => inbox.readIdentities(scope, after, through),
      readPendingInteractions: (scope, after, through, ids) => inbox.readPendingInteractions(scope, after, through, ids),
      async pull() { throw new BridgeOutboxReadError(status); },
      close: () => inbox.close(),
    },
  }, () => assert.fail("recovering a committed approval must not replay its old live event"));
  try {
    await inbox.storage.call("inbox", { batch: [{ seq: 1, route, generation: "g", payload }] });
    await session.open({ live: false });
    assert.deepEqual(await session.pendingInteractions("thread"), [
      { ...payload, params: { ...payload.params, threadId: "thread" } },
    ]);
    interactions.push({ route, id: "not-committed" });
    await assert.rejects(session.pendingInteractions("thread"), { status: 503 });
    interactions.pop();
    status = 409;
    await assert.rejects(session.pendingInteractions("thread"), { status: 409 });
  } finally { await session.close(); }
});

test("history and targeted approval recovery are independent of another retained approval body", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-approval-recovery-isolated-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = new GatewayInbox(join(root, "inbox.db"));
  const route = '["server","thread"]';
  const pending = ["blocked", "ready"];
  const selections: string[][] = [];
  let bodyUnavailable = true;
  const readPending = (scope: string, after: number, through: number, ids: readonly string[]) => {
    selections.push([...ids]);
    if (bodyUnavailable && ids.includes("blocked")) throw Error("Fixture approval body unavailable");
    return inbox.readPendingInteractions(scope, after, through, ids);
  };
  const session = new BridgeGatewaySession({
    serverId: "server",
    async request(path) {
      if (path.startsWith("/history-identities?"))
        return Response.json({ high: 3, acknowledged: 3, outboxId: "1".repeat(32), identities: [] });
      assert.equal(path.split("?")[0], "/snapshot");
      return Response.json({ routes: [], nativeSessions: [], historyIdentityPages: true,
        interactions: pending.map(id => ({ route, id })) });
    },
    inbox: {
      cursor: () => inbox.cursor(),
      read: after => inbox.read(after),
      readIdentities: (scope, after, through) => inbox.readIdentities(scope, after, through),
      readPendingInteractions: readPending,
      async pull() {},
      close: () => inbox.close(),
    },
  }, () => assert.fail("Retained approvals must not be republished"));
  try {
    await inbox.storage.call("inbox", { batch: [
      { seq: 1, route, generation: "g", payload: { event: {
        kind: "turn.started", nativeTurnId: "native-turn", turnId: "public-turn",
      } } },
      ...pending.map((interactionId, index) => ({
        seq: index + 2, route, generation: "g", payload: { method: "interaction/request", params: { interactionId } },
      })),
    ] });
    await session.open({ live: false });
    assert.deepEqual(await session.readProjectedHistory("thread", async () => ({ data: [{ id: "native-turn", items: [] }] })),
      { data: [{ id: "public-turn", items: [] }] });
    assert.deepEqual(selections, []);
    await assert.rejects(session.pendingInteractions("thread"), /Fixture approval body unavailable/);
    const request = (interactionId: string) => ({ method: "interaction/request", params: { threadId: "thread", interactionId } });
    assert.deepEqual(await session.pendingInteractions("thread", "ready"), [request("ready")]);
    assert.deepEqual(selections, [["blocked", "ready"], ["ready"]]);
    bodyUnavailable = false;
    assert.deepEqual(await session.pendingInteractions("thread"), [request("ready"), request("blocked")]);
  } finally { await session.close(); }
});

test("pending approval delivery and settlement stay scoped when two routes use the same producer ID", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-approval-route-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = new GatewayInbox(join(root, "inbox.db"));
  const route = (threadId: string) => JSON.stringify(["server", threadId]);
  const id = "producer-approval";
  let pending = ["left", "right"];
  const published: unknown[] = [];
  const session = new BridgeGatewaySession({
    serverId: "server",
    async request(path) {
      assert.equal(path.split("?")[0], "/snapshot");
      return Response.json({ routes: [], nativeSessions: [],
        interactions: pending.map(threadId => ({ route: route(threadId), id })) });
    },
    inbox: {
      cursor: () => inbox.cursor(),
      read: after => inbox.read(after),
      readIdentities: (...args) => inbox.readIdentities(...args),
      readPendingInteractions: (...args) => inbox.readPendingInteractions(...args),
      async pull() {},
      close: () => inbox.close(),
    },
  }, (threadId, value) => published.push({ threadId, value }));
  try {
    await inbox.storage.call("inbox", { batch: pending.map((threadId, index) => ({
      seq: index + 1, route: route(threadId), generation: "g",
      payload: { method: "interaction/request", params: { interactionId: id, title: threadId } },
    })) });
    await session.open({ live: false });
    const approval = (threadId: string) => ({
      method: "interaction/request", params: { interactionId: id, title: threadId, threadId },
    });
    assert.deepEqual(await session.pendingInteractions("left"), [approval("left")]);
    assert.deepEqual(await session.pendingInteractions("right"), [approval("right")]);
    assert.deepEqual(await session.pendingInteractions("left", id), [approval("left")]);

    pending = ["right"];
    assert.deepEqual(await session.pendingInteractions("left"), []);
    assert.deepEqual(await session.pendingInteractions("right", id), [approval("right")]);
    pending = [];
    await inbox.storage.call("inbox", { batch: ["right", "left"].map((threadId, index) => ({
      seq: index + 3, route: route(threadId), generation: "g",
      payload: { method: "interaction/resolved", params: { interactionId: id, reason: "resolved" } },
    })) });
    await session.pull();
    assert.deepEqual(await session.pendingInteractions("right"), []);
    assert.deepEqual(published, ["left", "right"].map(threadId => ({ threadId, value: {
      method: "interaction/resolved", params: { interactionId: id, threadId, reason: "resolved" },
    } })));
  } finally { await session.close(); }
});

test("a healthy first outbox page does not make an incomplete approval snapshot authoritative", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-approval-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = new GatewayInbox(join(root, "inbox.db"));
  const route = '["server","thread"]';
  const page = (seq: number, id: string) => [{ seq, route, generation: "g", payload: {
    method: "interaction/request", params: { interactionId: id },
  } }];
  let deliverSecond = false;
  const session = new BridgeGatewaySession({
    serverId: "server",
    async request(path) {
      assert.equal(path.split("?")[0], "/snapshot");
      return Response.json({ routes: [], nativeSessions: [], interactions: [
        { route, id: "first" }, { route, id: "second" },
      ] });
    },
    inbox: {
      cursor: () => inbox.cursor(),
      read: cursor => inbox.read(cursor),
      readIdentities: (scope, after, through) => inbox.readIdentities(scope, after, through),
      readPendingInteractions: (scope, after, through, ids) => inbox.readPendingInteractions(scope, after, through, ids),
      async pull() {
        const cursor = await inbox.cursor();
        const batch = cursor === 0 ? page(1, "first") : deliverSecond && cursor === 1 ? page(2, "second") : [];
        await inbox.storage.call("inbox", { batch });
      },
      close: () => inbox.close(),
    },
  }, () => {});
  try {
    await session.open({ live: false });
    await assert.rejects(session.pendingInteractions("thread"), { name: "BridgeInteractionSnapshotIncomplete" });
    deliverSecond = true;
    assert.deepEqual(await session.pendingInteractions("thread"), [
      ...page(1, "first"), ...page(2, "second"),
    ].map(({ payload }) => ({ ...payload, params: { ...payload.params, threadId: "thread" } })));
  } finally { await session.close(); }
});

test("an accepted approval receipt settles before the independent outbox read returns", async () => {
  const route = '["server","thread"]', id = "approval";
  const payload = { method: "interaction/request", params: { interactionId: id } };
  const events = [{ seq: 1, route, generation: "g", payload }];
  const observed: unknown[] = [];
  let block = false;
  const held = Promise.withResolvers<void>();
  const receipt = Promise.withResolvers<void>();
  const session = new BridgeGatewaySession({
    serverId: "server",
    async request(path) {
      if (path.split("?")[0] === "/snapshot") return Response.json({ routes: [], nativeSessions: [], interactions: [{ route, id }] });
      if (path === "/command") return Response.json(null);
      assert.equal(path, "/command?id=approval-answer");
      receipt.resolve();
      return Response.json({ state: "accepted", response: { result: {} } });
    },
    inbox: {
      async cursor() { return 0; }, async read(after) { return events.filter(row => row.seq > after); },
      async readIdentities() { return []; }, async readPendingInteractions() { return []; }, async close() {},
      async pull() { if (block) await held.promise; },
    },
  }, (_, value) => observed.push(value));
  let pending: Promise<unknown> | undefined;
  try {
    await session.open();
    block = true;
    const background = session.pull();
    let result: unknown;
    pending = session.command("thread", "approval-answer", "interaction/resolve", {
      interactionId: id, result: { decision: "decline" },
    }).then(value => { result = value; return value; });
    await receipt.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(result, {});
    assert.deepEqual(observed.map(value => (value as { method: string }).method), ["interaction/request", "interaction/resolved"]);
    events.push({ seq: 2, route, generation: "g", payload: { ...payload, method: "interaction/resolved" } });
    held.resolve();
    await background;
    assert.equal(observed.length, 2, "late outbox resolution must not publish the receipt twice");
  } finally {
    held.resolve();
    await pending;
    await session.close();
  }
});

test("gateway startup skips the old event log and lazily projects one retained route after inbox upgrade", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-projection-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "inbox.db"), route = '["server","selected"]', other = '["server","other"]';
  const { database } = openManagedDatabase({ path, migrations: resolveStoreMigrations("agent-bridge-host", migrations).filter(({ version }) => version < 5) });
  const insert = database.prepare("INSERT INTO inbox VALUES (?,?,?,?,'[]')");
  const add = (seq: number, scope: string, payload: unknown) => insert.run(seq, scope, "g", JSON.stringify(payload));
  database.exec("BEGIN");
  for (let seq = 1; seq <= 1000; seq++) add(seq, other, { method: "thread/status/changed" });
  add(1001, route, { kind: "canonical", event: { kind: "turn.started", nativeTurnId: "native-turn", turnId: "public-turn" } });
  add(1002, route, { kind: "canonical", event: { kind: "item.completed", item: { nativeKey: "native-item", itemId: "public-item", text: "synthetic" } } });
  add(1003, route, { method: "interaction/request", params: { interactionId: "retained", payload: { method: "item/tool/requestUserInput" } } });
  add(1004, route, { method: "interaction/request", params: { interactionId: "already-settled", payload: { text: "x".repeat(3 * 1024 * 1024) } } });
  add(1005, route, { method: "interaction/request", params: { interactionId: "peer-only", payload: { method: "item/tool/requestUserInput" } } });
  database.exec("UPDATE meta SET value='1005' WHERE key='ack'; COMMIT");
  database.close();
  const inbox = new GatewayInbox(path);
  assert.equal((await inbox.storage.ready).status, "migrated");
  const reads: number[] = [], selected: string[] = [];
  const restoredIds: string[] = [];
  const snapshot = { routes: [{ route, generation: "g" }], nativeSessions: [{ route, native_id: "native-thread", restorable: 1 }],
    interactions: [{ route, id: "retained" }, { route: other, id: "peer-only" }] };
  const session = new BridgeGatewaySession({
    serverId: "server",
    async request() { return Response.json(snapshot); },
    inbox: {
      cursor: () => inbox.cursor(), close: () => inbox.close(), async pull() {},
      read(cursor) { reads.push(cursor); return inbox.read(cursor); },
      readIdentities(scope, after, through) {
        selected.push(scope);
        return inbox.readIdentities(scope, after, through);
      },
      async readPendingInteractions(scope, after, through, ids) {
        const page = await inbox.readPendingInteractions(scope, after, through, ids);
        restoredIds.push(...page.map(row => row.id));
        return page;
      },
    },
  }, () => assert.fail("Retained events must not be republished"));
  try {
    await session.open();
    assert.deepEqual(reads, [1005]);
    assert.deepEqual(selected, []);
    assert.equal(session.publicThread("native-thread"), "selected");
    await session.hydrateThread("selected");
    assert.deepEqual(new Set(selected), new Set([route]));
    assert.deepEqual(restoredIds, []);
    assert.equal(session.nativeTurn("selected", "public-turn"), "native-turn");
    assert.deepEqual(session.history("selected", { turnId: "native-turn", itemId: "native-item" }),
      { turnId: "public-turn", itemId: "public-item" });
    assert.deepEqual((await session.pendingInteractions("selected")).map((frame: any) => frame.params.interactionId), ["retained"]);
    assert.deepEqual(restoredIds, ["retained"], "only this route's pending bodies cross the storage worker boundary");
    assert.deepEqual((await inbox.readIdentities(route, 0, 1005)).map(row => row.seq), [1001, 1002]);
  } finally {
    await session.close();
  }
  const tamper = new DatabaseSync(path);
  tamper.exec("UPDATE schema_migrations SET checksum='tampered' WHERE version=5");
  tamper.close();
  const broken = new GatewayInbox(path);
  await assert.rejects(broken.storage.ready, /migration history/);
  await broken.close().catch(() => {});
});

test("selected sandbox backend failure rejects execution and has no local fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = localTestBackend();
  backend.initialize = async () => {
    throw Error("unavailable");
  };
  const host = await BridgeHost.open({ path: join(root, "host.db"), policy, backend });
  await host.add(await config(root));
  await assert.rejects(host.activate("g1", ""), /provider could not initialize/);
  assert.equal((await host.snapshot()).current, "");
  await host.close().catch(() => {});
});

test("runtime guard forbids main-thread SQL and blocking filesystem IO through actual Host lifecycle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-guard-"));
  const proc = child("host-process.ts", { TEST_DB: join(root, "host.db"), TEST_TOKEN: token, GUARD_IO: "1" });
  t.after(async () => {
    await stop(proc);
    await rm(root, { recursive: true, force: true });
  });
  const [descriptor] = await once(proc, "message");
  await rpc(descriptor.url, "/generation/add", await config(root, "g1", descriptor.pid));
  await rpc(descriptor.url, "/generation/activate", { id: "g1", expected: "" });
  await rpc(descriptor.url, "/command", command("guarded"));
  assert.equal(
    (
      await until(
        () => rpc(descriptor.url, "/command?id=guarded"),
        (r) => r.state === "accepted",
      )
    ).state,
    "accepted",
  );
});

test("Host close reclaims a bridge and its background descendant process group", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-cleanup-"));
  const host = await BridgeHost.open({ path: join(root, "host.db"), policy, backend: localTestBackend() });
  t.after(() => rm(root, { recursive: true, force: true }));
  await host.add(await config(root));
  await host.activate("g1", "");
  await host.accept(command("child", "session/create", { spawnDescendant: true }));
  const receipt = await accepted(host, "child");
  const result = (receipt!.response as any).result;
  await host.close();
  // A killed descendant can briefly remain a zombie until PID 1 reaps it.
  for (const pid of [result.pid, result.descendant]) {
    await until(
      async () => {
        try {
          const stat = await readFile(`/proc/${pid}/stat`, "utf8");
          return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
        } catch {
          return true;
        }
      },
      (gone) => gone,
    );
  }
});

test("Worker loss rejects outstanding storage operations and cannot fall back to main-thread SQL", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-worker-loss-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Storage(join(root, "host.db"));
  await store.ready;
  await (store as any).worker.terminate();
  await assert.rejects(store.call("snapshot"), /worker exited/);
  await assert.rejects(store.close(), /worker exited/);
});

test("generation draining refuses unfinished text streams and queued inputs even after echo evidence and native close", async (t) => {
  for (const unsettled of ["stream", "queue"]) {
    const { host } = await setup(t);
    await host.accept(command("create", "session/create", { unsettled }));
    await accepted(host, "create");
    await host.accept(command("close", "session/close"));
    await accepted(host, "close");
    const events = await host.events(0);
    let cursor = events.at(-1).seq;
    await host.ack(cursor);
    await assert.rejects(host.releaseThread("server-1", "thread-1"), /work or unknown/);
    await host.accept(command("settle", "turn/stop", { settle: unsettled }));
    await accepted(host, "settle");
    cursor = (await host.events(cursor)).at(-1).seq;
    await host.ack(cursor);
    await host.releaseThread("server-1", "thread-1");
  }
});

test("storage Worker loss during a live native task reclaims the bridge and stops new admission", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-live-loss-"));
  const host = await BridgeHost.open({ path: join(root, "host.db"), policy, backend: localTestBackend() });
  t.after(async () => {
    await host.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await host.add(await config(root));
  await host.activate("g1", "");
  await host.accept(command("create"));
  const created = await accepted(host, "create");
  const pid = (created!.response as any).result.pid;
  await host.accept(command("start", "turn/start"));
  await accepted(host, "start");
  await (host as any).storage.worker.terminate();
  await until(
    async () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    (gone) => gone,
  );
  await assert.rejects(host.accept(command("new", "session/create", {}, "thread-2")), /Host closing/);
});

test("storage close seals new calls immediately and drains earlier requests before releasing its writer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-close-drain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Storage(join(root, "host.db"));
  await store.ready;
  const acceptedBeforeClose = store.call("snapshot");
  const closing = store.close();
  assert.equal(store.close(), closing);
  await assert.rejects(store.call("snapshot"), /closing or closed/);
  assert.equal((await acceptedBeforeClose).epoch, 1);
  await closing;
  const reopened = new Storage(join(root, "host.db"));
  await reopened.ready;
  assert.equal((await reopened.call("snapshot")).epoch, 2);
  await reopened.close();
});

test("deterministic provider refusals settle rejected; only ambiguous outcomes stay unknown", () => {
  assert.equal(dispatchSettlement({ jsonrpc: "2.0", id: "1", result: {} }), "accepted");
  for (const kind of [
    "explicit-reject",
    "invalid",
    "unsupported",
    "stale-target",
    "auth",
    "quota",
    "frame-too-large",
  ] as const) {
    assert.equal(
      dispatchSettlement({ jsonrpc: "2.0", id: "1", error: { kind, code: -32000, message: kind } }),
      "rejected",
      kind,
    );
  }
  for (const kind of ["unknown-outcome", "internal"] as const) {
    assert.equal(
      dispatchSettlement({ jsonrpc: "2.0", id: "1", error: { kind, code: -32000, message: kind } }),
      "unknown",
      kind,
    );
  }
});

test("execution CLI issuance follows custody admission, refuses missing proof and revokes at terminal output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-cli-"));
  let issued = 0,
    revoked = 0;
  const host = await BridgeHost.open({
    path: join(root, "host.db"),
    policy,
    backend: localTestBackend(),
    executionCli: {
      async issue(source) {
        assert.equal(source.credential, "signed-source");
        issued++;
        return {
          environment: { OPENCRAFT_THREAD_CLI: "fixture" },
          async revoke() {
            revoked++;
          },
        };
      },
    },
  });
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  const generation = await config(root, "g1", process.pid, true);
  await host.add(generation);
  await host.activate("g1", "");
  await host.accept(command("create"));
  await accepted(host, "create");
  await host.accept(command("denied", "turn/start"));
  const denied = await until(
    () => host.query("denied"),
    (r) => r?.state === "rejected",
  );
  assert.equal((denied!.response as any).error.message, "cliUnavailable");
  assert.deepEqual((denied!.response as any).error.data, { cliStage: "source" });
  assert.equal(issued, 0);
  await assert.rejects(readFile(join(root, "executions")));
  await host.accept(command("allowed", "turn/start", { executionSource: "signed-source" }));
  await accepted(host, "allowed");
  assert.equal(issued, 1);
  assert.equal((await readFile(join(root, "executions"), "utf8")).trim().split("\n").length, 1);
  await host.accept(command("close-refused", "session/close", { refuse: true }));
  await until(
    () => host.query("close-refused"),
    (receipt) => receipt?.state === "rejected",
  );
  assert.equal(revoked, 0, "a rejected close keeps the running execution credential live");
  await until(
    async () => revoked,
    (count) => count === 1,
  );
  await host.accept(command("allowed", "turn/start", { executionSource: "signed-source" }));
  assert.equal(issued, 1);
});

test("a held CLI revocation leaves other Threads free to commit and keeps its own lease fenced", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-cli-revocation-"));
  const held = Promise.withResolvers<void>();
  const issued: string[] = [];
  const revoked: string[] = [];
  const host = await BridgeHost.open({
    path: join(root, "host.db"),
    policy,
    backend: localTestBackend(),
    executionCli: {
      async issue({ threadId }) {
        issued.push(threadId);
        return {
          environment: { OPENCRAFT_THREAD_CLI: "fixture" },
          async revoke() {
            revoked.push(threadId);
            if (threadId === "thread-1") {
              await held.promise;
            }
          },
        };
      },
    },
  });
  t.after(async () => {
    held.resolve();
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  await host.add(await config(root, "g1", process.pid, true));
  await host.activate("g1", "");
  await host.accept(command("create"));
  await accepted(host, "create");
  const params = { executionSource: "signed-source", closeBeforeRefusal: true };
  await host.accept(command("first", "turn/start", params));
  await until(async () => revoked.includes("thread-1"), Boolean);

  await host.accept(command("create-other", "session/create", {}, "thread-2"));
  await accepted(host, "create-other");
  await host.accept(command("other", "turn/start", params, "thread-2"));
  await accepted(host, "other");
  await accepted(host, "first");
  const other = (await host.events(0)).filter(event => event.route === JSON.stringify(["server-1", "thread-2"]));
  assert.ok(other.some(event => (event.payload as any).event?.kind === "turn.completed"));

  await host.accept(command("fenced", "turn/start", params));
  const refused = await until(() => host.query("fenced"), receipt => receipt?.state === "rejected");
  assert.equal((refused!.response as any).error.message, "cliUnavailable");
  await host.accept(command("stop", "turn/stop"));
  await accepted(host, "stop");
  assert.deepEqual(issued, ["thread-1", "thread-2"]);
  assert.deepEqual(revoked, ["thread-1", "thread-2"]);
  held.resolve();
});

test("a rejected concurrent CLI admission cannot clear another command reservation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-cli-reservation-"));
  let release!: () => void,
    issued = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = await BridgeHost.open({
    path: join(root, "host.db"),
    policy,
    backend: localTestBackend(),
    executionCli: {
      async issue() {
        issued++;
        await gate;
        return { environment: { OPENCRAFT_THREAD_CLI: "fixture" }, async revoke() {} };
      },
    },
  });
  t.after(async () => {
    release();
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  const generation = await config(root, "g1", process.pid, true);
  await host.add(generation);
  await host.activate("g1", "");
  await host.accept(command("create"));
  await accepted(host, "create");
  await host.accept(command("first", "turn/start", { executionSource: "source" }));
  await until(
    async () => issued,
    (value) => value === 1,
  );
  for (const id of ["second", "third"]) {
    await host.accept(command(id, "turn/start", { executionSource: "source" }));
    await until(
      () => host.query(id),
      (receipt) => receipt?.state === "rejected",
    );
  }
  assert.equal(issued, 1);
  release();
  await accepted(host, "first");
});

for (const terminal of ["receipt", "callback"] as const)
  test("closing a Thread fences a pending CLI issuance on its " + terminal, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-cli-close-during-issue-"));
    const held = Promise.withResolvers<void>();
    let issued = 0, revoked = 0;
    const host = await BridgeHost.open({
      path: join(root, "host.db"),
      policy,
      backend: localTestBackend(),
      executionCli: {
        async issue() {
          issued++;
          await held.promise;
          return {
            environment: { OPENCRAFT_THREAD_CLI: "fixture" },
            async revoke() { revoked++; },
          };
        },
      },
    });
    t.after(async () => {
      held.resolve();
      await host.close();
      await rm(root, { recursive: true, force: true });
    });
    await host.add(await config(root, "g1", process.pid, true));
    await host.activate("g1", "");
    await host.accept(command("create"));
    await accepted(host, "create");
    await host.accept(command("pending", "turn/start", { executionSource: "source", closeBeforeRefusal: true }));
    await until(async () => issued, count => count === 1);

    await host.accept(command("end-session", "session/close", { holdAfterSessionEnd: terminal === "callback" }));
    if (terminal === "receipt") await accepted(host, "end-session");
    else {
      await until(() => readFile(join(root, "executions.end-ack"), "utf8").catch(() => ""), text => text === "durable\n");
      assert.equal((await host.query("end-session"))?.state, "dispatching");
    }
    const receipt = await host.query("pending");
    assert.equal(receipt?.state, "rejected", "the start receipt settles before the CLI lease returns");
    assert.equal((receipt?.response as any).error.message, "cliUnavailable");
    assert.equal(revoked, 0);
    if (terminal === "receipt") {
      const events = await host.events(0);
      await host.ack(events.at(-1)!.seq);
      await assert.rejects(host.releaseThread("server-1", "thread-1"), /still has work/);
    }
    held.resolve();
    await until(async () => revoked, count => count === 1);
    if (terminal === "receipt") await until(async () => {
      try { await host.releaseThread("server-1", "thread-1"); return true; }
      catch (error) { assert.match(String(error), /still has work/); return false; }
    }, Boolean);
    assert.deepEqual(await host.query("pending"), receipt);
    await assert.rejects(readFile(join(root, "executions")), { code: "ENOENT" });
    assert.equal((await host.diagnostics()).some(peer => peer.failed), false);
  });

for (const scope of ["pending", "targeted", "active"] as const)
  test("Stop preserves its scope during CLI issuance with " + scope + " work", async (t) => {
    const localStop = scope === "pending";
    const root = await mkdtemp(join(tmpdir(), "bridge-cli-stop-during-issue-"));
    const held = Promise.withResolvers<void>();
    let issued = 0, restored = 0, revoked = 0;
    const host = await BridgeHost.open({
      path: join(root, "host.db"),
      policy,
      backend: localTestBackend(),
      executionCli: {
        async reserve() {
          return { environment: { OPENCRAFT_THREAD_CLI: "fixture" }, async revoke() {} };
        },
        async issue() {
          issued++;
          await held.promise;
          return {
            environment: { OPENCRAFT_THREAD_CLI: "fixture" },
            async rejectBeforeStart() {
              restored++;
              return { environment: { OPENCRAFT_THREAD_CLI: "fixture" }, async revoke() {} };
            },
            async revoke() { revoked++; },
          };
        },
      },
    });
    t.after(async () => {
      held.resolve();
      await host.close();
      await rm(root, { recursive: true, force: true });
    });
    await host.add(await config(root, "g1", process.pid, true));
    await host.activate("g1", "");
    await host.accept(command("create"));
    await accepted(host, "create");
    if (scope === "active") {
      await host.accept(command("queue-start:existing", "turn/start", { hold: true }));
      await accepted(host, "queue-start:existing");
    }
    await host.accept(command("pending", "turn/start", { executionSource: "source", closeBeforeRefusal: true }));
    await until(async () => issued, count => count === 1);

    // The fake provider refuses the Stop so this setup also covers engines that
    // require a native Turn ID, which a pre-dispatch start does not have.
    await host.accept(command("stop", "turn/stop", scope === "targeted"
      ? { refuse: true, expectedTurnId: "old-native-turn" }
      : { refuse: true }));
    const stop = await until(() => host.query("stop"), receipt => receipt?.state === "accepted" || receipt?.state === "rejected");
    assert.equal(stop?.state, localStop ? "accepted" : "rejected");
    if (localStop) {
      assert.deepEqual((stop?.response as any).result, { stopped: true });
      assert.equal((await host.query("pending"))?.state, "rejected", "Stop settles the start while CLI issuance is still held");
      assert.equal((await host.accept(command("pending", "turn/start", { executionSource: "source", closeBeforeRefusal: true }))).state, "rejected");
      await host.accept(command("retry-during-cleanup", "turn/start", { executionSource: "source" }));
      await until(() => host.query("retry-during-cleanup"), receipt => receipt?.state === "rejected");
      assert.equal(issued, 1, "the pending lease still owns the route until cleanup");
      assert.equal(restored, 0);
    }

    held.resolve();
    const start = await until(() => host.query("pending"), receipt => receipt?.state === "accepted" || receipt?.state === "rejected");
    assert.equal(start?.state, localStop ? "rejected" : "accepted");
    if (!localStop) {
      assert.equal(restored, 0);
      assert.match(await readFile(join(root, "executions"), "utf8"), /host-command:pending/);
    } else {
      await until(async () => restored, count => count === 1);
      assert.equal(revoked, 0);
      assert.deepEqual(await host.query("pending"), start);
      await assert.rejects(readFile(join(root, "executions")), { code: "ENOENT" });
    }
  });

for (const recovery of ["normal", "stop", "shutdown", "shutdown-failed"] as const)
  test("cancelled CLI cleanup retains queue custody through " + recovery, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-cli-queue-wakeup-"));
    const issueGate = Promise.withResolvers<void>();
    const cleanupGate = Promise.withResolvers<void>();
    const cleanupFailed = Promise.withResolvers<void>();
    let issued = 0, revoking = 0, closed = false;
    const host = await BridgeHost.open({
      path: join(root, "host.db"),
      policy,
      backend: localTestBackend(),
      executionCli: {
        async issue() {
          issued++;
          await issueGate.promise;
          return {
            environment: { OPENCRAFT_THREAD_CLI: "fixture" },
            async revoke() {
              const attempt = ++revoking;
              await cleanupGate.promise;
              if ((recovery !== "normal" && attempt === 1) || recovery === "shutdown-failed") {
                cleanupFailed.resolve();
                throw Error("fixture could not revoke lease");
              }
            },
          };
        },
      },
    });
    t.after(async () => {
      issueGate.resolve();
      cleanupGate.resolve();
      if (!closed) await host.close();
      await rm(root, { recursive: true, force: true });
    });
    const generation = await config(root, "g1", process.pid, true);
    const artifact = resolve("tests/agent-bridge/fixtures/queue-bridge.mjs");
    const provider = { ...generation.provider, capabilities: { ...generation.provider.capabilities, history: true } };
    const handshake = negotiateHandshake({ protocolVersion: 1, grammarRange: { min: 1, max: 1 } }, provider);
    assert(handshake.ok);
    await host.add({
      ...generation, artifact, provider, digest: createHash("sha256").update(await readFile(artifact)).digest("hex"),
      launch: {
        ...generation.launch, command: [process.execPath, artifact],
        env: { ...generation.launch.env, HANDSHAKE: JSON.stringify(handshake.result) },
      },
    });
    await host.activate("g1", "");
    await host.accept(command("create"));
    await accepted(host, "create");
    await host.accept(command("held-start", "turn/start", { executionSource: "source" }));
    await until(async () => issued, count => count === 1);
    await host.accept(command("stop", "turn/stop"));
    await accepted(host, "stop");
    assert.equal((await host.query("held-start"))?.state, "rejected");

    const queue = (method: string, params: Record<string, unknown> = {}) =>
      host.queueRequest({ serverId: "server-1", threadId: "thread-1", method, params });
    await queue("thread/queue/add", { clientUserMessageId: "next", input: [{ type: "text", text: "queued" }] });
    const listed = await queue("thread/queue/list") as { data: unknown[] };
    assert.equal(listed.data.length, 1);
    issueGate.resolve();
    await until(async () => revoking, count => count === 1);
    await assert.rejects(readFile(join(root, "executions")), { code: "ENOENT" });

    cleanupGate.resolve();
    if (recovery !== "normal") {
      await cleanupFailed.promise;
      const receipt = await host.query("held-start");
      assert.equal(receipt?.state, "rejected");
      await assert.rejects(queue("thread/queue/start"), /Thread is not idle/);
      await assert.rejects(readFile(join(root, "executions")), { code: "ENOENT" });
      if (recovery === "shutdown" || recovery === "shutdown-failed") {
        const closing = host.close();
        closed = true;
        if (recovery === "shutdown-failed") await assert.rejects(closing, /Bridge owner cleanup unconfirmed/);
        else await closing;
        assert.equal(revoking, 2);
        await assert.rejects(readFile(join(root, "executions")), { code: "ENOENT" });
        return;
      }
      await host.accept(command("retry-stop", "turn/stop"));
      await accepted(host, "retry-stop");
      assert.equal(revoking, 2);
    }
    const executions = await until(() => readFile(join(root, "executions"), "utf8").catch(() => ""), Boolean);
    assert.equal(executions, "next\n");
    await until(() => queue("thread/queue/list") as Promise<{ data: unknown[] }>, state => state.data.length === 0);
    assert.equal(await readFile(join(root, "executions"), "utf8"), "next\n");
    assert.equal(issued, 1);
  });

test("a late CLI lease is revoked when its provider exits during issuance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-cli-late-"));
  let release!: () => void,
    issued = 0,
    revoked = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = await BridgeHost.open({
    path: join(root, "host.db"),
    policy,
    backend: localTestBackend(),
    executionCli: {
      async issue() {
        issued++;
        await gate;
        return {
          environment: { OPENCRAFT_THREAD_CLI: "fixture" },
          async revoke() {
            revoked++;
          },
        };
      },
    },
  });
  t.after(async () => {
    release();
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  await host.add(await config(root, "g1", process.pid, true));
  await host.activate("g1", "");
  await host.accept(command("create"));
  const created = await accepted(host, "create");
  const pid = (created!.response as any).result.pid;
  await host.accept(command("pending", "turn/start", { executionSource: "source" }));
  await until(
    async () => issued,
    (value) => value === 1,
  );
  process.kill(pid, "SIGKILL");
  await until(
    async () => host.diagnostics() as { failed: boolean }[],
    (rows) => rows.some((row) => row.failed),
  );
  release();
  await until(
    () => host.query("pending"),
    (receipt) => receipt?.state === "rejected",
  );
  assert.equal(revoked, 1);
  await assert.rejects(readFile(join(root, "executions")));
});

test("a Host CLI port does not block generations that do not declare CLI support", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-no-cli-"));
  const host = await BridgeHost.open({
    path: join(root, "host.db"),
    policy,
    backend: localTestBackend(),
    executionCli: {
      async issue() {
        throw Error("Unsupported generation reached CLI issuance");
      },
    },
  });
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  await host.add(await config(root));
  await host.activate("g1", "");
  await host.accept(command("create"));
  await accepted(host, "create");
  await host.accept(command("start", "turn/start"));
  await accepted(host, "start");
  assert.equal((await readFile(join(root, "executions"), "utf8")).trim().split("\n").length, 1);
});

for (const closeBeforeRefusal of [false, true])
  test(`a native start before refusal stays unknown even with terminal=${closeBeforeRefusal}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-started-refusal-"));
    let revoked = 0,
      rearmed = 0;
    const host = await BridgeHost.open({
      path: join(root, "host.db"),
      policy,
      backend: localTestBackend(),
      executionCli: {
        async issue() {
          return {
            environment: { OPENCRAFT_THREAD_CLI: "fixture" },
            async revoke() {
              revoked++;
            },
            async rejectBeforeStart() {
              rearmed++;
              return { environment: {}, async revoke() {} };
            },
          };
        },
      },
    });
    t.after(async () => {
      await host.close();
      await rm(root, { recursive: true, force: true });
    });
    await host.add(await config(root, "g1", process.pid, true));
    await host.activate("g1", "");
    await host.accept(command("create"));
    await accepted(host, "create");
    await host.accept(
      command("contradiction", "turn/start", { executionSource: "signed", refuseAfterStart: true, closeBeforeRefusal }),
    );
    await until(
      () => host.query("contradiction"),
      (r) => r?.state === "unknown",
    );
    assert.equal(rearmed, 0);
    assert.equal(revoked, closeBeforeRefusal ? 1 : 0);
    await until(
      async () => revoked,
      (n) => n === 1,
    );
    assert.equal(rearmed, 0);
    assert.equal((await readFile(join(root, "executions"), "utf8")).trim().split("\n").length, 1);
  });

test("a failed unbound CLI reservation rejects session creation before native dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-initial-refusal-"));
  const host = await BridgeHost.open({
    path: join(root, "host.db"),
    policy,
    backend: localTestBackend(),
    executionCli: {
      async reserve() {
        throw Error("unavailable");
      },
      async issue() {
        throw Error("must not issue");
      },
    },
  });
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  await host.add(await config(root, "g1", process.pid, true));
  await host.activate("g1", "");
  await host.accept(command("create"));
  const receipt = await until(
    () => host.query("create"),
    (r) => r?.state === "rejected",
  );
  assert.equal((receipt!.response as any).error.message, "cliUnavailable");
  assert.equal((await host.snapshot()).nativeSessions.length, 0);
});

test("closing an empty native allocation revokes its unbound CLI namespace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-empty-close-"));
  let revoked = 0;
  const host = await BridgeHost.open({
    path: join(root, "host.db"),
    policy,
    backend: localTestBackend(),
    executionCli: {
      async reserve() {
        return {
          environment: { OPENCRAFT_THREAD_CLI: "reserved" },
          async revoke() {
            revoked++;
          },
        };
      },
      async issue() {
        throw Error("No Turn should be issued");
      },
    },
  });
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  await host.add(await config(root, "g1", process.pid, true));
  await host.activate("g1", "");
  await host.accept(command("create"));
  await accepted(host, "create");
  assert.equal(revoked, 0);
  await host.accept(command("close", "session/close"));
  await accepted(host, "close");
  await until(
    async () => revoked,
    (n) => n === 1,
  );
  await assert.rejects(readFile(join(root, "executions")));
});

test("v4 thread queue migration keeps existing custody, serves the shared queue and refuses a tampered history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-queue-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "host.db");
  // A Host database exactly as the previous release left it: the three legacy migrations.
  let { database } = openManagedDatabase({ path, migrations });
  database.exec("INSERT INTO generations(id,config) VALUES ('g','{}')");
  database.exec("INSERT INTO routes VALUES ('[\"server\",\"thread\"]','g')");
  database.exec(
    "INSERT INTO commands VALUES ('original','digest',4,'[\"server\",\"thread\"]','g','turn/start','accepted',NULL)",
  );
  database.close();
  const route = '["server","thread"]';
  const store = new Storage(path);
  assert.equal((await store.ready).status, "migrated");
  assert.equal(
    (await store.call("query", { id: "original" })).state,
    "accepted",
    "existing command custody is preserved",
  );
  const added = await store.call("queue", {
    method: "add",
    args: [route, "client-1", [{ type: "text", text: "next" }]],
  });
  assert.equal(added.state, "queued");
  assert.equal((await store.call("queue", { method: "firstAwaitingAdmission", args: [route] })).id, added.id);
  await store.call("queueChanged", { route });
  const events = await store.call("events", { cursor: 0, limit: 10 });
  assert.deepEqual(events.at(-1).payload, { method: "thread/queue/changed", params: { threadId: route } });
  await assert.rejects(store.call("queue", { method: "close", args: [] }), /Unsupported queue operation/);
  await store.close();
  database = new DatabaseSync(path);
  assert.deepEqual(
    database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => row.version),
    resolveStoreMigrations("agent-bridge-host", migrations).map(row => row.version),
  );
  database.exec("UPDATE schema_migrations SET checksum='tampered' WHERE version=4");
  database.close();
  const broken = new Storage(path);
  await assert.rejects(broken.ready, /migration history/);
  await broken.close().catch(() => {});
});

test("queued input is sent by the Host itself when each turn ends, in order, and only once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-queue-"));
  const path = join(root, "host.db"),
    executions = join(root, "executions");
  await writeFile(executions, "");
  const artifact = resolve("tests/agent-bridge/fixtures/queue-bridge.mjs");
  const provider = { ...declaration, capabilities: { ...declaration.capabilities, history: true } };
  const handshake = negotiateHandshake({ protocolVersion: 1, grammarRange: { min: 1, max: 1 } }, provider);
  assert(handshake.ok);
  const generation: Generation = {
    id: "q1",
    artifact,
    digest: createHash("sha256")
      .update(await readFile(artifact))
      .digest("hex"),
    provider,
    launch: {
      command: [process.execPath, artifact],
      cwd: root,
      env: { HANDSHAKE: JSON.stringify(handshake.result), EXECUTIONS: executions },
    },
  };
  let host = await BridgeHost.open({ path, policy, backend: localTestBackend() });
  t.after(async () => {
    await host.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await host.add(generation);
  await host.activate("q1", "");
  await host.accept(command("create"));
  await accepted(host, "create");
  const queue = (method: string, params: Record<string, unknown> = {}) =>
    host.queueRequest({ serverId: "server-1", threadId: "thread-1", method, params });
  const text = (value: string) => [{ type: "text", text: value }];
  const sent = async () => (await readFile(executions, "utf8")).split("\n").filter(Boolean);

  await queue("thread/queue/add", { clientUserMessageId: "first", input: text("one") });
  await queue("thread/queue/add", { clientUserMessageId: "second", input: text("two") });
  await queue("thread/queue/add", { clientUserMessageId: "second", input: text("two") }); // same message, queued once
  // The idle Thread takes the head at once; the next waits for that turn to end, with no gateway involved.
  await until(sent, (rows) => rows.length === 2);
  assert.deepEqual(await sent(), ["first", "second"]);
  const listed: any = await until(
    () => queue("thread/queue/list"),
    (value: any) => value.data.length === 0 && value.steering.length === 0,
  );
  assert.deepEqual(listed.data, []);
  // Rows stay findable by queue or client identity after delivery (collaboration receipts read them).
  const byClient: any = await queue("thread/queue/find", { clientUserMessageId: "first" });
  assert.equal(byClient.queuedSubmission.clientUserMessageId, "first");
  assert.deepEqual(
    (await queue("thread/queue/find", { queuedSubmissionId: byClient.queuedSubmission.id }) as any).queuedSubmission,
    byClient.queuedSubmission,
  );
  assert.deepEqual(await queue("thread/queue/find", { clientUserMessageId: "never" }), { queuedSubmission: null });
  await assert.rejects(queue("thread/queue/find", {}), /exactly one/u);
  const events = await host.events(0);
  assert.ok(events.some((event: any) => event.payload.method === "thread/queue/changed"));
  await delay(400);
  assert.deepEqual(await sent(), ["first", "second"], "nothing is sent twice");

  // After a restart the Host requires explicit recovery of existing routes; queued input waits rather than running.
  await host.close();
  host = await BridgeHost.open({ path, policy, backend: localTestBackend() });
  await queue("thread/queue/add", { clientUserMessageId: "after-restart", input: text("three") });
  await delay(400);
  assert.deepEqual(await sent(), ["first", "second"]);
  assert.equal(((await queue("thread/queue/list")) as any).data[0].clientUserMessageId, "after-restart");
  await assert.rejects(queue("thread/queue/frobnicate"), /Unsupported queue method/);
});

test("an adoption must keep the Thread ID and needs the provider to declare adoption", async (t) => {
  const { host } = await setup(t);
  await assert.rejects(
    host.accept(command("adopt-other", "session/adopt", { providerThreadId: "someone-else" }, "thread-9")),
    /keeps its own Thread ID/,
  );
  // The fixture provider declares no adoption: the command is refused before reaching it, and the route is released.
  await host.accept(command("adopt-plain", "session/adopt", { providerThreadId: "thread-9" }, "thread-9"));
  assert.equal(
    (
      await until(
        () => host.query("adopt-plain"),
        (r) => r?.state === "rejected",
      )
    )?.state,
    "rejected",
  );
});

test("after a restart, a provider that adopts sessions takes back the recorded one and queued input moves again", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-recover-"));
  const path = join(root, "host.db"),
    executions = join(root, "executions");
  await writeFile(executions, "");
  const artifact = resolve("tests/agent-bridge/fixtures/queue-bridge.mjs");
  const provider = { ...declaration, capabilities: { ...declaration.capabilities, history: true, adoption: true } };
  const handshake = negotiateHandshake({ protocolVersion: 1, grammarRange: { min: 1, max: 1 } }, provider);
  assert(handshake.ok);
  const generation: Generation = {
    id: "r1",
    artifact,
    digest: createHash("sha256")
      .update(await readFile(artifact))
      .digest("hex"),
    provider,
    launch: {
      command: [process.execPath, artifact],
      cwd: root,
      env: { HANDSHAKE: JSON.stringify(handshake.result), EXECUTIONS: executions },
    },
  };
  let host = await BridgeHost.open({ path, policy, backend: localTestBackend() });
  t.after(async () => {
    await host.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await host.add(generation);
  await host.activate("r1", "");
  await host.accept(command("create"));
  await accepted(host, "create");
  const queue = (method: string, params: Record<string, unknown> = {}) =>
    host.queueRequest({ serverId: "server-1", threadId: "thread-1", method, params });
  const sent = async () => (await readFile(executions, "utf8")).split("\n").filter(Boolean);
  await queue("thread/queue/add", { clientUserMessageId: "before", input: [{ type: "text", text: "one" }] });
  await until(sent, (rows) => rows.length === 1);
  // Restart only once that turn has ended; an unfinished one would rightly keep the queue waiting.
  await until(
    () => queue("thread/queue/list") as Promise<any>,
    (value: any) => value.data.length === 0 && value.steering.length === 0,
  );

  await host.close();
  host = await BridgeHost.open({ path, policy, backend: localTestBackend() });
  await queue("thread/queue/add", { clientUserMessageId: "after", input: [{ type: "text", text: "two" }] });
  const rows = await until(sent, (rows) => rows.length === 3);
  // The new provider process was handed the recorded native session by the Host before anything was sent.
  assert.deepEqual(rows, ["before", 'adopt:native-["server-1","thread-1"]', "after"]);
  // A read after recovery needs no second adoption.
  await host.observe({
    serverId: "server-1",
    threadId: "thread-1",
    method: "history/read",
    params: { view: "thread" },
  });
  assert.equal((await sent()).filter((row) => row.startsWith("adopt:")).length, 1);
});

for (const marksConnectionLoss of [true, false])
test(`a lost Codex attachment recovers without replay, with native fault marker=${marksConnectionLoss}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-attachment-"));
  const executions = join(root, "executions"),
    launches = join(root, "launches"),
    unavailable = join(root, "native-unavailable");
  await writeFile(executions, "");
  const artifact = resolve("tests/agent-bridge/fixtures/queue-bridge.mjs");
  const provider = {
    ...declaration,
    providerId: "codex",
    capabilities: { ...declaration.capabilities, adoption: true, history: true },
  };
  const handshake = negotiateHandshake({ protocolVersion: 1, grammarRange: { min: 1, max: 1 } }, provider);
  assert(handshake.ok);
  const host = await BridgeHost.open({
    path: join(root, "host.db"),
    policy,
    backend: localTestBackend(),
    requestTimeoutMs: 2_000,
  });
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  await host.add({
    id: "codex-attachment",
    artifact,
    digest: createHash("sha256")
      .update(await readFile(artifact))
      .digest("hex"),
    provider,
    launch: {
      command: [process.execPath, artifact],
      cwd: root,
      env: {
        HANDSHAKE: JSON.stringify(handshake.result),
        EXECUTIONS: executions,
        BRIDGE_LAUNCHES: launches,
        NATIVE_UNAVAILABLE: unavailable,
        DROP_NATIVE_ON_INPUT: "interrupted-input",
        ...(marksConnectionLoss ? {} : { EXIT_WITHOUT_NATIVE_FAULT: "1" }),
      },
    },
  });
  await host.activate("codex-attachment", "");
  await host.accept(command("old-session"));
  const original = await accepted(host, "old-session");

  await writeFile(unavailable, "");
  const inFlight = command("interrupted-command", "turn/start", {
    native: { clientUserMessageId: "interrupted-input", input: [{ type: "text", text: "one" }] },
  });
  await host.accept(inFlight);
  await until(
    () => host.query(inFlight.commandId),
    (receipt) => receipt?.state === "unknown",
  );
  const [failed] = host.diagnostics() as { failure: string; nativeFault: string | null }[];
  assert.equal(failed?.failure, "transport");
  assert.equal(failed?.nativeFault, marksConnectionLoss ? "codex-native-fault:unknown:connection" : null);

  await host.accept(command("during-outage", "session/create", {}, "second-thread"));
  const unavailableReceipt = await until(
    () => host.query("during-outage"),
    (receipt) => receipt?.state === "rejected",
  );
  assert.equal((unavailableReceipt?.response as any).error.message, "Codex provider attachment is unavailable");
  assert.equal((await host.accept(inFlight)).state, "unknown");

  await rm(unavailable);
  await delay(1_050);
  const history = host.observe({
    serverId: "server-1",
    threadId: "thread-1",
    method: "history/read",
    params: { view: "thread" },
  });
  const next = host.accept(command("after-reconnect", "session/create", {}, "second-thread"));
  const [historyResult] = await Promise.all([history, next]);
  assert.equal((historyResult as any).thread.id, 'native-["server-1","thread-1"]');
  assert.equal((await accepted(host, "after-reconnect"))?.epoch, original?.epoch);
  assert.equal((await readFile(launches, "utf8")).trim().split("\n").length, 3);
  assert.deepEqual((await readFile(executions, "utf8")).trim().split("\n"), [
    "interrupted-input",
    'adopt:native-["server-1","thread-1"]',
  ]);
  assert.equal((await host.query(inFlight.commandId))?.state, "unknown");
});

test("an idle Thread moves to the current provider generation at its next turn, so provider updates reach it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-migrate-"));
  const executions = join(root, "executions");
  await writeFile(executions, "");
  const artifact = resolve("tests/agent-bridge/fixtures/queue-bridge.mjs");
  const provider = { ...declaration, capabilities: { ...declaration.capabilities, history: true, adoption: true } };
  const handshake = negotiateHandshake({ protocolVersion: 1, grammarRange: { min: 1, max: 1 } }, provider);
  assert(handshake.ok);
  const digest = createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
  const generation = (id: string): Generation => ({
    id,
    artifact,
    digest,
    provider,
    launch: {
      command: [process.execPath, artifact],
      cwd: root,
      env: { HANDSHAKE: JSON.stringify(handshake.result), EXECUTIONS: executions, GENERATION: id },
    },
  });
  const host = await BridgeHost.open({ path: join(root, "host.db"), policy, backend: localTestBackend() });
  t.after(async () => {
    await host.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await host.add(generation("old"));
  await host.activate("old", "");
  await host.accept(command("create"));
  await accepted(host, "create");
  const sent = async () => (await readFile(executions, "utf8")).split("\n").filter(Boolean);
  await host.accept({
    ...command("first"),
    method: "turn/start",
    params: { native: { clientUserMessageId: "first", input: [{ type: "text", text: "one" }] } },
  });
  await until(sent, (rows) => rows.includes("first"));
  await until(
    () => host.query("first"),
    (receipt: any) => receipt?.state === "accepted",
  );
  // An update: a new generation becomes current while the Thread is idle.
  await host.add(generation("new"));
  await host.activate("new", "old");
  await until(async () => (await host.snapshot()).generations.length === 2, Boolean);
  // Wait until the first turn has closed in the Host, then start the next one.
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await host.threadState("server-1", "thread-1");
    if (Object.keys(state.state.openTurns ?? {}).length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // The gateway has not acknowledged what the old generation produced yet.
  const delivered = await host.events(0, 256);
  assert.ok(delivered.length > 0, "the first turn left events in the old generation's outbox");
  await host.accept({
    ...command("second"),
    method: "turn/start",
    params: { native: { clientUserMessageId: "second", input: [{ type: "text", text: "two" }] } },
  });
  const rows = await until(sent, (rows) => rows.includes("second"));
  assert.deepEqual(rows, [
    "first",
    'release:["server-1","thread-1"]@old',
    'adopt:native-["server-1","thread-1"]@new',
    "second",
  ]);
  const retired = async () =>
    (await host.snapshot()).generations.find((row: any) => row.id === "old").retired;
  const snapshot = await host.snapshot();
  assert.equal(snapshot.routes.find((row: any) => row.route === '["server-1","thread-1"]').generation, "new");
  assert.equal(await retired(), 0, "a generation with unacknowledged events stays until they are delivered");
  // Acknowledging the old generation's events drains it; nothing else uses it, so it is retired.
  const all = await host.events(0, 256);
  await host.ack(Math.max(...all.map((event: any) => event.seq)));
  assert.equal(await retired(), 1, "a generation nothing uses any more is retired once its events are acknowledged");
});

test("after an update, a Thread whose old provider cannot hand it over moves on its first use after the restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-migrate-restart-"));
  const path = join(root, "host.db"),
    executions = join(root, "executions");
  await writeFile(executions, "");
  const artifact = resolve("tests/agent-bridge/fixtures/queue-bridge.mjs");
  const provider = { ...declaration, capabilities: { ...declaration.capabilities, history: true, adoption: true } };
  const handshake = negotiateHandshake({ protocolVersion: 1, grammarRange: { min: 1, max: 1 } }, provider);
  assert(handshake.ok);
  const digest = createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
  const generation = (id: string, extra: Record<string, string> = {}): Generation => ({
    id,
    artifact,
    digest,
    provider,
    launch: {
      command: [process.execPath, artifact],
      cwd: root,
      env: { HANDSHAKE: JSON.stringify(handshake.result), EXECUTIONS: executions, GENERATION: id, ...extra },
    },
  });
  let host = await BridgeHost.open({ path, policy, backend: localTestBackend() });
  t.after(async () => {
    await host.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  // The old build cannot release a session it holds.
  await host.add(generation("old", { NO_RELEASE: "1" }));
  await host.activate("old", "");
  await host.accept(command("create"));
  await accepted(host, "create");
  const delivered = await host.events(0, 256);
  if (delivered.length) await host.ack(Math.max(...delivered.map((event: any) => event.seq)));
  await host.close();
  // The update: a new Host process with a new current generation.
  host = await BridgeHost.open({ path, policy, backend: localTestBackend() });
  await host.add(generation("new"));
  await host.activate("new", "old");
  await host.observe({
    serverId: "server-1",
    threadId: "thread-1",
    method: "history/read",
    params: { view: "thread" },
  });
  const rows = (await readFile(executions, "utf8")).split("\n").filter(Boolean);
  assert.deepEqual(rows, ['adopt:native-["server-1","thread-1"]@new'], "only the current build takes the session");
  const snapshot = await host.snapshot();
  assert.equal(snapshot.routes.find((row: any) => row.route === '["server-1","thread-1"]').generation, "new");
});

test("a retained failed Codex adoption binds once and sends after Host restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-retry-adoption-"));
  const path = join(root, "host.db");
  const executions = join(root, "executions");
  const artifact = resolve("tests/agent-bridge/fixtures/queue-bridge.mjs");
  const provider = { ...declaration, providerId: "codex", capabilities: { ...declaration.capabilities, adoption: true, cliExecutable: true } };
  const handshake = negotiateHandshake({ protocolVersion: 1, grammarRange: { min: 1, max: 1 } }, provider);
  assert.ok(handshake.ok);
  const generation = {
    id: "codex-test", artifact, provider, digest: createHash("sha256").update(await readFile(artifact)).digest("hex"),
    launch: { command: [process.execPath, artifact], cwd: root,
      env: { HANDSHAKE: JSON.stringify(handshake.result), EXECUTIONS: executions, REFUSE_DUPLICATE_ADOPTION: "1" } },
  };
  const open = (executionCli?: Parameters<typeof BridgeHost.open>[0]["executionCli"]) =>
    BridgeHost.open({ path, policy, backend: localTestBackend(), executionCli,
      startup: { generations: [generation], activate: generation.id, cutoverCodex: true } });
  let host = await open({
    async reserve() { throw Error("fixture CLI temporarily unavailable"); },
    async issue() { throw Error("fixture must not issue a CLI"); },
  });
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  const adoption = (id: string) => command(id, "session/adopt", { providerThreadId: "thread-1" });
  await host.accept(adoption("failed-adoption"));
  const rejected = await until(() => host.query("failed-adoption"), receipt => receipt?.state === "rejected");
  assert.equal(rejected?.response && "error" in rejected.response && rejected.response.error.message, "cliUnavailable");
  assert.deepEqual((await host.snapshot()).nativeSessions, []);
  assert.equal((await host.snapshot()).routes.length, 1);
  await host.close();

  host = await open();
  await host.accept(adoption("retry-adoption"));
  const bound = await accepted(host, "retry-adoption");
  assert.equal(bound?.identities?.nativeThreadId, "thread-1");
  await host.accept(command("continue", "turn/start", {
    native: { clientUserMessageId: "after-adoption", input: [{ type: "text", text: "continue the same thread" }] },
  }));
  const send = await until(() => host.query("continue"), receipt => receipt?.state === "accepted" || receipt?.state === "rejected");
  assert.equal(send?.state, "accepted");
  assert.deepEqual((await readFile(executions, "utf8")).trim().split("\n"), ["adopt:thread-1", "after-adoption"]);
});

test("Codex startup switches all existing bindings before serving, preserving history identity and unknown receipts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-cutover-"));
  const path = join(root, "host.db");
  const executions = join(root, "executions");
  const oldLaunches = join(root, "old-launches");
  const nativeHistory = join(root, "native-history.json");
  const nativeThreadId = 'native-["server-1","thread-1"]';
  const historicalTurn = {
    id: "older-turn", status: "completed", items: [{ id: "older-message", type: "agentMessage", text: "A reply before the upgrade" }],
  };
  await writeFile(nativeHistory, JSON.stringify({ [nativeThreadId]: [historicalTurn] }));
  const artifact = resolve("tests/agent-bridge/fixtures/queue-bridge.mjs");
  const digest = createHash("sha256").update(await readFile(artifact)).digest("hex");
  const provider = { ...declaration, providerId: "codex", capabilities: { ...declaration.capabilities, history: true, adoption: true } };
  const handshake = negotiateHandshake({ protocolVersion: 1, grammarRange: { min: 1, max: 1 } }, provider);
  assert(handshake.ok);
  const generation = (id: string, env: Record<string, string> = {}): Generation => ({
    id, artifact, digest, provider,
    launch: {
      command: [process.execPath, artifact], cwd: root,
      env: { HANDSHAKE: JSON.stringify(handshake.result), EXECUTIONS: executions, GENERATION: id, NATIVE_HISTORY: nativeHistory, ...env },
    },
  });
  const open = (startup?: NonNullable<Parameters<typeof BridgeHost.open>[0]["startup"]>) =>
    BridgeHost.open({ path, policy, backend: localTestBackend(), startup });
  let host = await open();
  t.after(async () => {
    await host.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await host.add(await config(root, "other"));
  await host.activate("other", "");
  await host.accept(command("other-create", "session/create", {}, "unrelated"));
  await accepted(host, "other-create");
  await host.add(generation("old", {
    BRIDGE_LAUNCHES: oldLaunches, DROP_NATIVE_ON_INPUT: "unconfirmed-send", TURN_MS: "60000",
  }));
  await host.activate("old", "other");
  await host.accept(command("running-create", "session/create", {}, "running"));
  await accepted(host, "running-create");
  await host.accept(command("running-start", "turn/start", {
    native: { clientUserMessageId: "running-input", input: [{ type: "text", text: "keep running" }] },
  }, "running"));
  await accepted(host, "running-start");
  await host.accept(command("create"));
  await accepted(host, "create");
  const historyRequest = { serverId: "server-1", threadId: "thread-1", method: "history/read", params: { view: "thread", includeTurns: true } };
  const historyBefore = await host.observe(historyRequest);
  assert.deepEqual(historyBefore, { thread: { id: nativeThreadId, turns: [historicalTurn] } });
  const send = command("unknown-start", "turn/start", {
    native: { clientUserMessageId: "unconfirmed-send", input: [{ type: "text", text: "hello" }] },
  });
  await host.accept(send);
  const unknown = await until(() => host.query(send.commandId), receipt => receipt?.state === "unknown");
  const before = await host.snapshot();
  const events = await host.events(0);
  await host.close();

  const unavailable = join(root, "unavailable");
  await writeFile(unavailable, "");
  const next = generation("new", { NATIVE_UNAVAILABLE: unavailable });
  const startup = { generations: [next], activate: next.id, cutoverCodex: true };
  await assert.rejects(open(startup));
  host = await open();
  assert.equal((await host.snapshot()).current, before.current);
  assert.deepEqual((await host.snapshot()).routes, before.routes);
  await host.close();
  await rm(unavailable);

  host = await open(startup);
  const after = await host.snapshot();
  assert.equal(after.current, "new");
  await assert.rejects(host.accept(command("forged-recovery", "session/adopt", {
    providerThreadId: "thread-1", recoverActive: true,
  })), /Only the Host can recover a retained execution/);
  assert.deepEqual(after.routes.map((row: any) => [row.route, row.generation]), [
    ['["server-1","unrelated"]', "other"],
    ['["server-1","running"]', "new"],
    ['["server-1","thread-1"]', "new"],
  ]);
  assert.deepEqual(after.nativeSessions, before.nativeSessions.map((row: any) => ({
    ...row, generation: row.generation === "old" ? "new" : row.generation,
  })));
  assert.deepEqual((await host.events(0)).slice(0, events.length), events);
  assert.deepEqual(await host.accept(send), unknown);
  await until(async () => (await readFile(executions, "utf8")).split("\n"),
    rows => rows.includes('adopt:native-["server-1","running"]@new'));
  assert.deepEqual(await host.observe(historyRequest), historyBefore);
  assert.equal(await readFile(oldLaunches, "utf8"), "launch\n");
  assert.deepEqual((await readFile(executions, "utf8")).trim().split("\n"), [
    "running-input",
    "unconfirmed-send",
    'adopt:native-["server-1","running"]@new',
    'adopt:native-["server-1","thread-1"]@new',
  ]);
});

test("with the execution CLI enabled, the Host still delivers its queue (without the CLI); a direct turn without proof is refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-queue-cli-"));
  const executions = join(root, "executions");
  await writeFile(executions, "");
  const artifact = resolve("tests/agent-bridge/fixtures/queue-bridge.mjs");
  const provider = { ...declaration, capabilities: { ...declaration.capabilities, history: true, cliExecutable: true } };
  const handshake = negotiateHandshake({ protocolVersion: 1, grammarRange: { min: 1, max: 1 } }, provider);
  assert(handshake.ok);
  let issued = 0;
  const host = await BridgeHost.open({
    path: join(root, "host.db"), policy, backend: localTestBackend(),
    executionCli: { async issue() { issued++; return { environment: {}, async revoke() {} }; } },
  });
  t.after(async () => {
    await host.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await host.add({
    id: "q1", artifact, digest: createHash("sha256").update(await readFile(artifact)).digest("hex"), provider,
    launch: { command: [process.execPath, artifact], cwd: root, env: { HANDSHAKE: JSON.stringify(handshake.result), EXECUTIONS: executions } },
  });
  await host.activate("q1", "");
  await host.accept(command("create"));
  await accepted(host, "create");
  await host.accept(command("direct", "turn/start"));
  assert.equal(((await until(() => host.query("direct"), (r) => r?.state === "rejected"))!.response as any).error.message, "cliUnavailable");
  await host.queueRequest({ serverId: "server-1", threadId: "thread-1", method: "thread/queue/add",
    params: { clientUserMessageId: "queued", input: [{ type: "text", text: "one" }] } });
  await until(async () => (await readFile(executions, "utf8")).split("\n").filter(Boolean), (rows) => rows.includes("queued"));
  assert.equal(issued, 0, "no credential was issued for the queued turn");
});

test("streaming deltas flow over SSE in causal order without writing outbox, inbox, or callback rows", async (t) => {
  const { host, root } = await setup(t);
  const endpoint = await attachGateway(host, token);
  const inboxPath = join(root, "stream-inbox.db");
  const received: { method: string; delta?: string; text?: string }[] = [];
  const gateway = new BridgeGateway({ url: endpoint.url, token, serverId: "server-1", inboxPath }, (_threadId, raw) => {
    const frame = raw as { method: string; params?: any };
    received.push({
      method: frame.method,
      ...(typeof frame.params?.delta === "string" ? { delta: frame.params.delta } : {}),
      ...(typeof frame.params?.item?.text === "string" ? { text: frame.params.item.text } : {}),
    });
  });
  t.after(async () => {
    await gateway.close();
    await endpoint.close();
  });
  await gateway.open();
  await gateway.command("thread-1", "create-sse", "session/create", {});
  await gateway.command("thread-1", "start-sse", "turn/start", {});
  await until(async () => received, (frames) => frames.some((f) => f.method === "turn/completed"));

  const methods = received.map((f) => f.method);
  const startedIdx = methods.indexOf("item/started");
  const completedIdx = methods.indexOf("item/completed");
  assert(startedIdx >= 0 && completedIdx > startedIdx, "item/started precedes item/completed");
  const deltas = received.slice(startedIdx + 1, completedIdx).filter((f) => f.method === "item/agentMessage/delta");
  assert.deepEqual(
    deltas.map((f) => f.delta),
    Array.from({ length: 15 }, (_, index) => `${index + 1},`),
    "all 15 textDelta chunks arrive over SSE in exact order before item/completed",
  );
  assert.equal(
    received.slice(completedIdx + 1).filter((f) => f.method === "item/agentMessage/delta").length,
    0,
    "no textDelta arrives after item/completed",
  );

  await gateway.close();
  await host.close();
  const inboxDb = new DatabaseSync(inboxPath, { readOnly: true });
  const hostDb = new DatabaseSync(join(root, "host.db"), { readOnly: true });
  try {
    const inboxPayloads = inboxDb.prepare("SELECT payload FROM inbox ORDER BY seq").all() as { payload: string }[];
    assert(
      inboxPayloads.every((row) => !row.payload.includes("agentMessage.delta")),
      "ephemeral deltas never enter the durable gateway inbox SQLite table",
    );
    assert(
      inboxPayloads.length >= 5 && inboxPayloads.length <= 6,
      `expected only structural events in inbox, got ${inboxPayloads.length}`,
    );
    const callbackCount = (hostDb.prepare("SELECT count(*) AS count FROM callbacks").get() as { count: number }).count;
    assert.equal(callbackCount, 3, "15 ephemeral delta callbacks bypass the durable callbacks SQLite table");
    const checkpointState = JSON.parse(
      (hostDb.prepare("SELECT state FROM checkpoints WHERE route=?").get('["server-1","thread-1"]') as { state: string }).state,
    );
    assert.deepEqual(checkpointState.openTurns, {});
  } finally {
    inboxDb.close();
    hostDb.close();
  }
});

test("polling-only BridgeGatewaySession drains ephemeral text and notification deltas in causal order and drops stale deltas", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-ephemeral-poll-"));
  const hostPath = join(root, "host.db");
  const inboxPath = join(root, "inbox.db");
  const storage = new Storage(hostPath, "host");
  t.after(async () => {
    await storage.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await storage.ready;
  await storage.call("add", await config(root));
  await storage.call("activate", { id: "g1", expected: "" });
  const route = JSON.stringify(["server-1", "thread-1"]);
  await storage.call("admit", { command: command("create"), route, digest: "create", maxSpoolBytes: 1 << 20 });
  await storage.call("dispatch", { id: "create" });
  await storage.call("settle", { id: "create", state: "accepted" });
  await storage.call("callback", {
    generation: "g1", id: "cb-id", method: "thread/identity",
    params: { threadId: route, providerThreadId: "native-t1", sessionRestorable: true },
  });
  await storage.close();

  const host = await BridgeHost.open({ path: hostPath, policy, backend: localTestBackend() });
  const endpoint = await attachGateway(host, token);
  const inbox = new GatewayInbox(inboxPath);
  const frames: any[] = [];
  const request = (path: string, body?: unknown) => fetch(endpoint.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const session = new BridgeGatewaySession({
    serverId: "server-1",
    request,
    inbox: {
      cursor: () => inbox.cursor(),
      read: (cursor) => inbox.read(cursor),
      readIdentities: (r, after, through, sel) => inbox.readIdentities(r, after, through, sel),
      readPendingInteractions: (r, after, through, ids) => inbox.readPendingInteractions(r, after, through, ids),
      pull: () => inbox.pull(endpoint.url, token),
      close: () => inbox.close(),
    },
  }, (_threadId, frame) => frames.push(frame));
  t.after(async () => {
    await session.close();
    await endpoint.close();
    await host.close();
  });

  await session.open({ live: false });
  const hostInternal = host as any;
  const emitCallback = async (id: string, method: string, params: Record<string, unknown>) => {
    const committed = await hostInternal.storage.call("callback", { generation: "g1", id, method, params });
    for (const item of committed.ephemeral ?? []) hostInternal.publishEphemeral(item);
  };
  await emitCallback("cb-open", "thread/delta", {
    threadId: route,
    deltas: [
      { op: "turn.open", nativeTurnId: "nt-1", scope: { threadId: route } },
      { op: "item.open", nativeKey: "cmd-1", shape: { kind: "command", command: "ls", cwd: "/", status: "inProgress" }, scope: { threadId: route } },
    ],
  });
  await emitCallback("cb-out-delta", "thread/notification", {
    threadId: route,
    method: "item/commandExecution/outputDelta",
    params: { turnId: "nt-1", itemId: "cmd-1", delta: "file.txt\n" },
  });
  await emitCallback("cb-close-cmd", "thread/delta", {
    threadId: route,
    deltas: [
      { op: "item.close", nativeKey: "cmd-1", shape: { kind: "command", command: "ls", cwd: "/", status: "completed", output: "file.txt\n", exitCode: 0 }, scope: { threadId: route } },
    ],
  });
  // Late outputDelta arriving after item.close must be dropped rather than emitted after item/completed.
  await emitCallback("cb-stale-delta", "thread/notification", {
    threadId: route,
    method: "item/commandExecution/outputDelta",
    params: { turnId: "nt-1", itemId: "cmd-1", delta: "stale\n" },
  });

  await session.pull();
  assert.deepEqual(
    frames.map((f) => f.method),
    ["turn/started", "item/started", "item/commandExecution/outputDelta", "item/completed"],
  );
  const startedItem = frames.find((f) => f.method === "item/started")!.params.item;
  const outputDelta = frames.find((f) => f.method === "item/commandExecution/outputDelta")!.params;
  assert.equal(outputDelta.itemId, startedItem.id, "ephemeral notification rewrites native item ID to canonical ID");
  assert.equal(outputDelta.delta, "file.txt\n");
});

test("SSE outbox wakeup arriving while inbox.pull is already in flight coalesces into an immediate follow-up pull", async () => {
  let streamMessage: ((msg: any) => void) | undefined;
  let storedEvents: OutboxEvent[] = [];
  let inboxCursor = 0;
  let pullCount = 0;
  const pullStarted = Promise.withResolvers<void>();
  const releaseFirstPull = Promise.withResolvers<void>();
  const delivered: any[] = [];
  const route = JSON.stringify(["server-1", "thread-coalesce"]);

  const session = new BridgeGatewaySession(
    {
      serverId: "server-1",
      async request(path) {
        if (path.startsWith("/snapshot")) {
          return new Response(
            JSON.stringify({
              current: "g1",
              generations: [],
              routes: [{ route, generation: "g1" }],
              nativeSessions: [],
              interactions: [],
              ephemeralStream: true,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      subscribeStream(handlers) {
        streamMessage = handlers.onMessage;
        return () => {
          streamMessage = undefined;
        };
      },
      inbox: {
        async cursor() {
          return inboxCursor;
        },
        async readIdentities() {
          return [];
        },
        async readPendingInteractions() {
          return [];
        },
        async read(after) {
          return storedEvents.filter((row) => row.seq > after);
        },
        async pull() {
          const attempt = ++pullCount;
          if (attempt === 2) {
            pullStarted.resolve();
            await releaseFirstPull.promise;
            storedEvents = [
              {
                seq: 1,
                route,
                generation: "g1",
                payload: { method: "thread/queue/changed", params: { threadId: route } },
              },
            ];
            inboxCursor = 1;
            return;
          }
          if (attempt >= 3) {
            storedEvents = [
              ...storedEvents,
              {
                seq: 2,
                route,
                generation: "g1",
                payload: { method: "thread/archived", params: { threadId: route } },
              },
            ];
            inboxCursor = 2;
          }
        },
        async close() {},
      },
    },
    (_threadId, frame) => delivered.push(frame),
  );

  await session.open();
  assert.equal(pullCount, 1);
  // Connect SSE stream (`hello` triggers catch-up pull #2).
  streamMessage!({ kind: "hello", streamId: "stream-1", highStreamSeq: 0 });
  await pullStarted.promise;
  assert.equal(session.isStreamConnected(), true);
  // While pull #2 is mid-flight, a new structural event commits at seq=2.
  streamMessage!({ kind: "outbox", high: 2 });
  releaseFirstPull.resolve();

  await until(async () => delivered.map((f) => f.method), (methods) => methods.includes("thread/archived"));
  assert.deepEqual(delivered.map((f) => f.method), ["thread/queue/changed", "thread/archived"]);
  assert.equal(pullCount, 3, "in-flight outbox wakeup schedules exactly one follow-up pull without polling");
  await session.close();
});

test("GatewayInbox skips redundant /ack HTTP writes and cursor Worker queries on empty no-op pulls while still acknowledging unconfirmed cursors on reopen", async (t) => {
  const { host, root } = await setup(t);
  const endpoint = await attachGateway(host, token);
  let ackRequests = 0;
  endpoint.server.on("request", (req) => {
    if (req.url === "/ack") ackRequests++;
  });
  const inboxPath = join(root, "noop-ack-inbox.db");
  let inbox = new GatewayInbox(inboxPath);
  t.after(async () => {
    await inbox.close().catch(() => {});
    await endpoint.close();
  });

  // Initial empty pull at cursor=0 skips /ack completely.
  assert.deepEqual(await inbox.pull(endpoint.url, token), []);
  assert.equal(ackRequests, 0, "empty pull at cursor=0 sends zero /ack requests");

  // Emit one real structural event: pull commits seq=1 and sends one /ack.
  await host.accept({ serverId: "server-1", threadId: "thread-ack", commandId: "create-ack", method: "session/create", params: {} });
  await until(async () => inbox.pull(endpoint.url, token), (rows) => rows.length > 0);
  const acksAfterCommit = ackRequests;
  assert.ok(acksAfterCommit >= 1);

  // Subsequent empty pulls at an already-acknowledged cursor send zero /ack requests and zero Worker cursor RPCs.
  let workerCalls = 0;
  const origCall = inbox.storage.call.bind(inbox.storage);
  inbox.storage.call = ((op: string, args?: unknown) => {
    workerCalls++;
    return origCall(op, args);
  }) as typeof inbox.storage.call;
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(await inbox.pull(endpoint.url, token), []);
  }
  assert.equal(ackRequests, acksAfterCommit, "repeated empty pulls at acknowledged cursor send zero /ack requests");
  assert.equal(workerCalls, 0, "repeated empty pulls reuse cached cursor and skip empty inbox apply");

  // Reopened GatewayInbox with cursor > 0 sends exactly one catch-up /ack on its first empty pull, then goes silent again.
  await inbox.close();
  inbox = new GatewayInbox(inboxPath);
  assert.deepEqual(await inbox.pull(endpoint.url, token), []);
  assert.equal(ackRequests, acksAfterCommit + 1, "reopened inbox confirms cursor > 0 once");
  assert.deepEqual(await inbox.pull(endpoint.url, token), []);
  assert.equal(ackRequests, acksAfterCommit + 1, "subsequent empty pulls after reopen stay silent");
});

test("Peer notification ephemeral callbacks track cached outbox high-water mark and route ownership across rebind", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-peer-notif-"));
  const storage = new Storage(join(root, "host.db"), "host");
  t.after(async () => {
    await storage.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await storage.ready;
  await storage.call("add", await config(root, "g1"));
  await storage.call("add", await config(root, "g2"));
  await storage.call("activate", { id: "g1", expected: "" });
  const route = JSON.stringify(["server-1", "thread-1"]);
  await storage.call("admit", { command: command("c1"), route, digest: "d1", maxSpoolBytes: 1 << 20 });
  await storage.call("dispatch", { id: "c1" });
  await storage.call("settle", { id: "c1", state: "accepted" });

  const incarnation = "01234567-89ab-4def-8012-3456789abcde";
  const openTurn = await storage.call("callback", {
    generation: "g1",
    id: `${incarnation}:request:open`,
    method: "thread/delta",
    params: {
      threadId: route,
      deltas: [
        { op: "turn.open", nativeTurnId: "nt-1", scope: { threadId: route } },
        { op: "item.open", nativeKey: "m-1", shape: { kind: "agentMessage", text: "" }, scope: { threadId: route } },
      ],
    },
  });
  assert.equal(openTurn.structuralWritten, true);
  assert.equal(openTurn.high, 2);

  const deltaNotif = await storage.call("callback", {
    generation: "g1",
    id: `${incarnation}:notification:1`,
    method: "thread/delta",
    params: {
      threadId: route,
      deltas: [{ op: "item.textDelta", nativeTurnId: "nt-1", nativeKey: "m-1", channel: "agentMessage", text: "fast", scope: { threadId: route } }],
    },
  });
  assert.equal(deltaNotif.structuralWritten, false);
  assert.equal(deltaNotif.high, 2);
  assert.equal(deltaNotif.ephemeral.length, 1);
  assert.equal(deltaNotif.ephemeral[0].afterSeq, 2);

  await assert.rejects(
    storage.call("callback", {
      generation: "g2",
      id: `${incarnation}:notification:2`,
      method: "thread/notification",
      params: { threadId: route, method: "item/commandExecution/outputDelta", params: { turnId: "nt-1", itemId: "c-1", delta: "x" } },
    }),
    /Callback generation does not own Thread/,
  );

  // Close turn and rebind route to g2; cached route ownership must update immediately.
  await storage.call("callback", {
    generation: "g1",
    id: `${incarnation}:request:close`,
    method: "thread/delta",
    params: {
      threadId: route,
      deltas: [
        { op: "item.close", nativeKey: "m-1", shape: { kind: "agentMessage", text: "fast" }, scope: { threadId: route } },
        { op: "turn.close", nativeTurnId: "nt-1", status: "completed", scope: { threadId: route } },
      ],
    },
  });
  await storage.call("rebindRoute", { route, from: "g1", to: "g2" });

  await assert.rejects(
    storage.call("callback", {
      generation: "g1",
      id: `${incarnation}:notification:3`,
      method: "thread/notification",
      params: { threadId: route, method: "item/commandExecution/outputDelta", params: { turnId: "nt-1", itemId: "c-1", delta: "x" } },
    }),
    /Callback generation does not own Thread/,
  );
  const movedNotif = await storage.call("callback", {
    generation: "g2",
    id: `${incarnation}:notification:4`,
    method: "thread/notification",
    params: { threadId: route, method: "item/commandExecution/outputDelta", params: { turnId: "nt-1", itemId: "c-1", delta: "ok" } },
  });
  assert.equal(movedNotif.structuralWritten, false);
  assert.equal(movedNotif.high, 4);
  assert.equal(movedNotif.ephemeral[0].afterSeq, 4);
});
