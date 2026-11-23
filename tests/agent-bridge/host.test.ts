import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openManagedDatabase } from "@opencraft/sqlite-node";
import {
  BridgeHost,
  GatewayInbox,
  attachGateway,
  dispatchSettlement,
  type Generation,
} from "../../apps/agent-bridge-host/src/index.js";
import { Storage } from "../../apps/agent-bridge-host/src/storage.js";
import { migrations } from "../../apps/agent-bridge-host/src/migrations.js";
import { localTestBackend } from "./fixtures/local-backend.js";
import { negotiateHandshake, type BridgeDeclaration } from "@opencraft/agent-bridge-protocol";
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
  await assert.rejects(reopened.storage.call("inbox", { batch: [{ ...event, seq: 3 }] }), /gap/);
  assert.equal((await reopened.read()).length, 1);
  await reopened.close();
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
    [1, 2, 3, 4],
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
  // The gateway has delivered everything the old generation produced.
  const delivered = await host.events(0, 256);
  if (delivered.length) await host.ack(Math.max(...delivered.map((event: any) => event.seq)));
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
  const snapshot = await host.snapshot();
  assert.equal(snapshot.routes.find((row: any) => row.route === '["server-1","thread-1"]').generation, "new");
  assert.equal(
    snapshot.generations.find((row: any) => row.id === "old").retired,
    1,
    "a generation nothing uses any more is retired",
  );
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
