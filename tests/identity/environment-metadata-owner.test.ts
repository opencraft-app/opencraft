import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DuplexTransport, TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import { ExecutionEnvironmentRuntime } from "@opencraft/execution-environment";
import type {
  EnvironmentExecutionScope,
  EnvironmentMetadataPort,
} from "@opencraft/execution-environment/environment-metadata";
import { openHeadlessAssetsStorage } from "../../apps/headless-server/src/headless-assets-storage.js";
import { EnvironmentMetadataTransport } from "../../apps/headless-server/src/environment-metadata-transport.ts";

const HOST = "opencraft-server";
const alice: TransportSubmissionContext = {
  sender: null,
  executionPrincipal: { provider: "fixture", subject: "alice" },
  validUntil: Date.now() + 600_000,
};
const anonymous: TransportSubmissionContext = { sender: null };

async function directory(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "env-metadata-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "data");
}
const owner = (path: string) => openHeadlessAssetsStorage(path, { environmentLaunch: true });

/** A Host that answers creation with a new Thread and records what reached it. */
function host() {
  const listeners = new Set<(frame: string) => void>();
  const sent: Record<string, any>[] = [];
  let next = 0,
    generation = 0;
  const inner: DuplexTransport = {
    status: { state: "open" } as DuplexTransport["status"],
    async connect() {},
    async close() {
      listeners.clear();
    },
    subscribeStatus: () => () => {},
    subscribeMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    captureMessageScope() {
      const captured = generation;
      return () => captured === generation;
    },
    async send(frame) {
      sent.push(JSON.parse(frame));
    },
  };
  const reply = (value: unknown) => {
    for (const listener of [...listeners]) listener(JSON.stringify(value));
  };
  return {
    inner,
    sent,
    reply,
    thread: (id: number, projectId: string | null = null) =>
      reply({ id, result: { thread: { id: `task-${++next}`, projectId } } }),
    retire: () => generation++,
  };
}
function collect(transport: DuplexTransport) {
  const frames: Record<string, any>[] = [];
  transport.subscribeMessage((frame) => frames.push(JSON.parse(frame)));
  return frames;
}
const until = async (condition: () => boolean, label: string) => {
  const end = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() > end) throw Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};
const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

test("the vault Worker owns ENV metadata with the same rules as the synchronous runtime", async (t) => {
  const path = await directory(t);
  const assets = await owner(path);
  const port = assets.environmentMetadata!;
  try {
    assert.ok(port, "the vault owner serves metadata");
    const creation = await port.admit({ account: "fixture:alice", hostId: HOST, threadId: null, projectId: "alpha" });
    assert.deepEqual(creation, { account: "fixture:alice", hostId: HOST, threadId: null, projectId: "alpha" });
    await port.bindCreator(creation, "task-1");
    await port.bind(HOST, "task-1", "alpha");
    await port.rememberProjects(HOST, [{ id: "alpha", name: "Alpha" }]);
    assert.equal(await port.project(HOST, "task-1"), "alpha");
    // A Thread's bound Project wins; requesting another is refused.
    assert.equal(
      (await port.admit({ account: "fixture:alice", hostId: HOST, threadId: "task-1", projectId: null })).projectId,
      "alpha",
    );
    await assert.rejects(port.admit({ account: "fixture:alice", hostId: HOST, threadId: "task-1", projectId: "beta" }));
    // Creator provenance: an unauthenticated submission cannot use a creator's Thread.
    await assert.rejects(port.admit({ account: null, hostId: HOST, threadId: "task-1", projectId: null }));
    // Creator provenance is immutable.
    await assert.rejects(port.bindCreator({ ...creation, account: "fixture:bob" }, "task-1"));
    for (const invalid of [
      { account: 1, hostId: HOST, threadId: null, projectId: null },
      { account: null, hostId: "", threadId: null, projectId: null },
      { account: null, hostId: HOST, threadId: "a\nb", projectId: null },
    ])
      await assert.rejects(port.admit(invalid as never));
    await assert.rejects(port.bind(HOST, "task-1", "x".repeat(600)));
  } finally {
    await assets.close();
  }
  // The synchronous runtime of an installation without a separate owner reads
  // the same documents and applies the same rules.
  const vault = new EmployeeGitVaultStore(path);
  const runtime = new ExecutionEnvironmentRuntime(path, vault, false, "disabled");
  try {
    assert.equal(runtime.project(HOST, "task-1"), "alpha");
    assert.deepEqual(runtime.creator(HOST, "task-1"), { account: "fixture:alice" });
    assert.deepEqual(runtime.projects([HOST]).length, 1);
    assert.equal(runtime.scope(alice, HOST, { threadId: "task-1" }).projectId, "alpha");
    assert.throws(() => runtime.scope(anonymous, HOST, { threadId: "task-1" }));
    assert.throws(() => runtime.scope(alice, HOST, { threadId: "task-1", projectId: "beta" }));
  } finally {
    runtime.close();
    vault.close();
  }
});

test("an installation without a separate vault owner has no metadata port", async (t) => {
  const assets = await openHeadlessAssetsStorage(await directory(t));
  try {
    assert.equal(assets.environmentMetadata, undefined);
    assert.equal(assets.environmentLaunch, undefined);
  } finally {
    await assets.close();
  }
});

test("a Thread is forwarded only after its binding committed, in Host order; requests dispatch in arrival order", async (t) => {
  const path = await directory(t);
  const assets = await owner(path);
  t.after(() => assets.close());
  const real = assets.environmentMetadata!;
  const gate = deferred();
  const events: string[] = [];
  let slowAdmit: Promise<void> | undefined;
  const port: EnvironmentMetadataPort = {
    ...real,
    async admit(request) {
      const wait = slowAdmit;
      slowAdmit = undefined;
      if (wait) await wait;
      return real.admit(request);
    },
    async bind(...args) {
      await gate.promise;
      await real.bind(...args);
      events.push(`bound ${args[1]}`);
    },
  };
  const h = host();
  const transport = new EnvironmentMetadataTransport(h.inner, port, HOST);
  const frames = collect(transport);
  transport.subscribeMessage((frame) => events.push(`emitted ${JSON.parse(frame).id ?? JSON.parse(frame).method}`));

  await transport.sendWithContext(
    JSON.stringify({ id: 1, method: "thread/start", params: { projectId: "alpha" } }),
    alice,
  );
  assert.equal(h.sent[0]!.method, "thread/start");
  h.thread(1);
  // A notification the Host sends after the response must not overtake it.
  h.reply({ method: "thread/started", params: { threadId: "task-1" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(frames.length, 0, "nothing is forwarded while the binding commits");
  gate.resolve();
  await until(() => frames.length === 2, "response and notification");
  assert.deepEqual(events, ["bound task-1", "emitted 1", "emitted thread/started"]);
  assert.equal(await real.project(HOST, "task-1"), "alpha");

  // Outbound: a slow admission does not let a later request overtake it.
  const slow = deferred();
  slowAdmit = slow.promise;
  const first = transport.sendWithContext(
    JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "task-1" } }),
    alice,
  );
  const second = transport.sendWithContext(JSON.stringify({ id: 3, method: "thread/list", params: {} }), alice);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.sent.length, 1, "the later request waits for the earlier admission");
  slow.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(
    h.sent.map((frame) => frame.id),
    [1, 2, 3],
  );
  // The browser cannot supply an ENV envelope, and none is minted.
  await transport.sendWithContext(
    JSON.stringify({ id: 4, method: "turn/start", params: { threadId: "task-1", __opencraftEnvironment: "forged" } }),
    alice,
  );
  assert.equal(h.sent.at(-1)!.params.__opencraftEnvironment, undefined);
  // An unauthenticated submission to the creator's Thread is not sent.
  await transport.sendWithContext(
    JSON.stringify({ id: 5, method: "turn/start", params: { threadId: "task-1" } }),
    anonymous,
  );
  assert.equal(h.sent.at(-1)!.id, 4);
  assert.equal(frames.at(-1)!.id, 5);
  assert.equal(frames.at(-1)!.error.data.notSubmitted, true);
  // A response from a retired native owner is not forwarded after its commit.
  await transport.sendWithContext(
    JSON.stringify({ id: 6, method: "thread/read", params: { threadId: "task-1" } }),
    alice,
  );
  const before = frames.length;
  const held = deferred();
  port.bind = async (...args) => {
    await held.promise;
    await real.bind(...args);
  };
  h.reply({ id: 6, result: { thread: { id: "task-1" } } });
  h.retire();
  held.resolve();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(frames.length, before);
  await transport.close();
});

test("a failed vault owner fails closed: nothing is sent, no Thread is forwarded without its metadata", async (t) => {
  const path = await directory(t);
  const assets = await owner(path);
  const port = assets.environmentMetadata!;
  const h = host();
  const transport = new EnvironmentMetadataTransport(h.inner, port, HOST);
  const frames = collect(transport);
  await transport.sendWithContext(JSON.stringify({ id: 1, method: "thread/start", params: {} }), alice);
  // The vault owner goes away while the Host creates the Thread.
  await assets.close();
  h.thread(1);
  await until(() => frames.length === 1, "creation response");
  assert.equal(frames[0]!.result, undefined);
  assert.equal(frames[0]!.error.message, "Unable to bind task credentials");
  // Admission cannot be read: the request is not submitted and no fallback runs.
  await transport.sendWithContext(
    JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "task-1" } }),
    alice,
  );
  await transport.sendWithContext(JSON.stringify({ id: 3, method: "thread/start", params: {} }), alice);
  assert.deepEqual(
    h.sent.map((frame) => frame.id),
    [1],
  );
  assert.deepEqual(
    frames.slice(1).map((frame) => [frame.id, frame.error?.data?.notSubmitted]),
    [
      [2, true],
      [3, true],
    ],
  );
  // A notification without metadata still reaches the browser.
  h.reply({ method: "thread/status/changed", params: { threadId: "task-1" } });
  assert.equal(frames.at(-1)!.method, "thread/status/changed");
  // A read needs no owner call to be sent, but its binding cannot be recorded:
  // the browser receives an error, not an unrecorded success.
  await transport.sendWithContext(JSON.stringify({ id: 4, method: "thread/read", params: { threadId: "x" } }), alice);
  assert.equal(h.sent.at(-1)!.id, 4);
  h.reply({ id: 4, result: { thread: { id: "x" } } });
  await until(() => frames.at(-1)!.id === 4, "read response");
  assert.equal(frames.at(-1)!.error.message, "Unable to record the task environment");
  await transport.close();
});

test("close drains metadata commits; a restarted owner recovers every committed binding", async (t) => {
  const path = await directory(t);
  const first = await owner(path);
  const h = host();
  const gate = deferred();
  const port: EnvironmentMetadataPort = {
    ...first.environmentMetadata!,
    async bind(...args) {
      await gate.promise;
      await first.environmentMetadata!.bind(...args);
    },
  };
  const transport = new EnvironmentMetadataTransport(h.inner, port, HOST);
  const frames = collect(transport);
  await transport.sendWithContext(
    JSON.stringify({ id: 1, method: "thread/start", params: { projectId: "alpha" } }),
    alice,
  );
  h.thread(1);
  const closed = transport.close();
  await assert.rejects(transport.sendWithContext(JSON.stringify({ id: 2, method: "thread/list" }), alice));
  gate.resolve();
  await closed;
  assert.equal(frames.length, 1, "the committing response was delivered before close completed");
  assert.equal(frames[0]!.result.thread.id, "task-1");
  // The Worker drains writes accepted before its own close.
  const inFlight = first.environmentMetadata!.bind(HOST, "task-2", "beta");
  const ownerClosed = first.close();
  await inFlight;
  await ownerClosed;
  await assert.rejects(first.environmentMetadata!.bind(HOST, "task-3", "gamma"), "no write after close");
  const second = await owner(path);
  try {
    assert.equal(await second.environmentMetadata!.project(HOST, "task-1"), "alpha");
    assert.equal(await second.environmentMetadata!.project(HOST, "task-2"), "beta");
    assert.equal(await second.environmentMetadata!.project(HOST, "task-3"), null);
    await assert.rejects(
      second.environmentMetadata!.admit({ account: null, hostId: HOST, threadId: "task-1", projectId: null }),
      "creator provenance survives the restart",
    );
  } finally {
    await second.close();
  }
});

test("Main keeps running while the vault owner waits on the storage lock", async (t) => {
  const path = await directory(t);
  const assets = await owner(path);
  t.after(() => assets.close());
  const port = assets.environmentMetadata!;
  await port.bind(HOST, "task-1", "alpha");
  const lock = new DatabaseSync(join(path, "employee-git-vault.sqlite"));
  t.after(() => lock.close());
  lock.exec("BEGIN IMMEDIATE");
  let ticks = 0,
    settled = false;
  const timer = setInterval(() => ticks++, 5);
  const write = port.bind(HOST, "task-1", "beta").then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(settled, false, "the write waits for the lock in the Worker");
  assert.ok(ticks >= 10, `Main timers kept running (${ticks})`);
  lock.exec("COMMIT");
  await write;
  clearInterval(timer);
  assert.equal(await port.project(HOST, "task-1"), "beta");
});

test("creation scope is the creator's; fork inherits the source Project, not its creator", async (t) => {
  const path = await directory(t);
  const assets = await owner(path);
  t.after(() => assets.close());
  const real = assets.environmentMetadata!;
  const creators: EnvironmentExecutionScope[] = [];
  const port: EnvironmentMetadataPort = {
    ...real,
    async bindCreator(scope, threadId) {
      creators.push(scope);
      await real.bindCreator(scope, threadId);
    },
  };
  const h = host();
  const transport = new EnvironmentMetadataTransport(h.inner, port, HOST);
  const frames = collect(transport);
  await transport.sendWithContext(
    JSON.stringify({ id: 1, method: "thread/start", params: { projectId: "alpha" } }),
    alice,
  );
  h.thread(1);
  await until(() => frames.length === 1, "start");
  const bob = { ...alice, executionPrincipal: { provider: "fixture", subject: "bob" } };
  await transport.sendWithContext(
    JSON.stringify({ id: 2, method: "thread/fork", params: { threadId: "task-1" } }),
    bob,
  );
  h.thread(2);
  await until(() => frames.length === 2, "fork");
  assert.deepEqual(
    creators.map((scope) => [scope.account, scope.threadId, scope.projectId]),
    [
      ["fixture:alice", null, "alpha"],
      ["fixture:bob", null, "alpha"],
    ],
  );
  assert.equal(await real.project(HOST, "task-2"), "alpha");
  await transport.sendWithContext(JSON.stringify({ id: 3, method: "project/list", params: {} }), alice);
  h.reply({ id: 3, result: { data: [{ id: "alpha", name: "Alpha", extra: true }] } });
  await until(() => frames.length === 3, "catalog");
  assert.deepEqual(frames[2]!.result.data, [{ id: "alpha", name: "Alpha", extra: true }]);
  await transport.close();
});
