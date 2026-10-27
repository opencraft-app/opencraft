import assert from "node:assert/strict";
import test from "node:test";
import { createCordisAppServerClient, JsonRpcAppServerClient, type AppServerClient } from "@opencraft/appserver-client";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import type { TransportStatus } from "@opencraft/appserver-client/transport";
import { statusAdapters, statusTransportFixture } from "./fixtures/transport-status";
import { executionChannelsFixture, flush } from "./fixtures/execution-channels";

import { generateTransportChaos, parseTransportTrace, simulateTransportStatus, type TransportChaosEvent, type TransportChaosMutant } from "./fixtures/transport-status-chaos";
import { ChaosViolation, shrinkChaosFailure } from "./fixtures/recovery-chaos";

for (const kind of statusAdapters) {
  test(`${kind} status observers cannot turn native open into connection failure`, { timeout: 5000 }, async () => {
    const f = statusTransportFixture(kind); let peerOpen = 0;
    const remove = f.transport.subscribeStatus(s => { if (s.state === "open") throw Error("Synthetic status observer failure"); });
    const peer = f.transport.subscribeStatus(s => { if (s.state === "open") peerOpen++; });
    try { await assert.doesNotReject(f.connect()); assert.equal(f.transport.status.state, "open"); assert.equal(peerOpen, 1); }
    finally { remove(); peer(); await f.close(); }
  });

  test(`${kind} an unused duplicate token cannot remove a same-function successor`, async () => {
    const f = statusTransportFixture(kind); let terminal = 0;
    const listener = (s: TransportStatus) => { if (s.state === "closed") terminal++; };
    const old = f.transport.subscribeStatus(listener), duplicate = f.transport.subscribeStatus(listener);
    try {
      await f.connect(); old(); const current = f.transport.subscribeStatus(listener);
      duplicate(); duplicate(); await f.transport.close(); assert.equal(terminal, 1); current();
    } finally { old(); duplicate(); await f.close(); }
  });

  test(`${kind} preserves same-function deduplication within one live registration`, async () => {
    const f = statusTransportFixture(kind); let terminal = 0;
    const listener = (s: TransportStatus) => { if (s.state === "closed") terminal++; };
    const a = f.transport.subscribeStatus(listener), b = f.transport.subscribeStatus(listener);
    try { await f.connect(); await f.transport.close(); assert.equal(terminal, 1); }
    finally { a(); b(); await f.close(); }
  });

  test(`${kind} replacement during publication receives only its explicit initial sample`, async () => {
    const f = statusTransportFixture(kind); let calls = 0, entered = false;
    let removePeer = () => {};
    const listener = (s: TransportStatus) => { if (s.state === "open") calls++; };
    const a = f.transport.subscribeStatus(s => {
      if (s.state !== "open" || entered) return;
      entered = true; removePeer(); removePeer = f.transport.subscribeStatus(listener);
    });
    removePeer = f.transport.subscribeStatus(listener);
    try { await f.connect(); assert.equal(calls, f.initialSample ? 1 : 0); }
    finally { a(); removePeer(); await f.close(); }
  });

  test(`${kind} reentrant close cannot publish an obsolete open to the next peer`, async () => {
    const f = statusTransportFixture(kind); let closing: Promise<void> | undefined;
    const seen: { event: string; current: string }[] = [];
    const a = f.transport.subscribeStatus(s => { if (s.state === "open") closing = f.transport.close(); });
    const b = f.transport.subscribeStatus(s => { seen.push({ event: s.state, current: f.transport.status.state }); });
    try {
      await f.connect().catch(() => {}); await closing; await flush();
      assert.ok(closing); assert.equal(f.transport.status.state, "closed");
      assert.ok(seen.every(row => row.event !== "open" || row.current === "open"), JSON.stringify(seen));
    } finally { a(); b(); await f.close(); }
  });

  test(`${kind} preserves its initial-sample behavior and bare-function receiver`, async () => {
    const f = statusTransportFixture(kind), receivers: unknown[] = [];
    const remove = f.transport.subscribeStatus(function(this: unknown) { receivers.push(this); });
    try {
      assert.equal(receivers.length, f.initialSample ? 1 : 0);
      await f.connect(); assert.ok(receivers.length > 0); assert.ok(receivers.every(value => value === undefined));
    } finally { remove(); await f.close(); }
  });

  if (["memory", "websocket", "replay"].includes(kind)) test(`${kind} initial observer failure still returns a valid unsubscribe token`, async () => {
    const f = statusTransportFixture(kind); let remove: (() => void) | undefined;
    try {
      assert.doesNotThrow(() => { remove = f.transport.subscribeStatus(s => { if (s.state === "idle") throw Error("Synthetic initial sample failure"); }); });
      assert.equal(typeof remove, "function"); remove!(); await f.connect();
    } finally { remove?.(); await f.close(); }
  });
}

test("WebSocket connect settles despite an open observer failure, including later abort and close", async () => {
  const f = statusTransportFixture("websocket"), controller = new AbortController(); let result = "pending";
  const remove = f.transport.subscribeStatus(s => { if (s.state === "open") throw Error("Synthetic status observer failure"); });
  const connecting = f.transport.connect(controller.signal); void connecting.then(() => { result = "resolved"; }, () => { result = "rejected"; });
  try {
    try { f.socket!.emitOpen(); } catch { /* Observe promise completion independently of the escaping callback. */ }
    await flush(); controller.abort(); await f.transport.close(); await flush();
    assert.equal(result, "resolved", "an observer must not orphan the physical-open promise even after its private settled flag changes");
  } finally { remove(); await f.close(); }
});

for (const facade of [false, true]) test(`status observer failure cannot hide physical loss from a pending ${facade ? "Cordis" : "raw"} Client request`, async () => {
  const f = executionChannelsFixture();
  const remove = f.transport.subscribeStatus(s => { if (s.state === "closed") throw Error("Synthetic closed observer failure"); });
  const cordis = facade ? await createCordisAppServerClient({ hostId: "status-loss", transport: f.transport }) : null;
  const client: AppServerClient = cordis?.client ?? new JsonRpcAppServerClient({ hostId: "status-loss", transport: f.transport });
  let result = "pending", closeError: unknown;
  try {
    await client.connect({ clientInfo: { name: "status-loss", version: "1" } }); f.hold = true;
    void client.request("thread/read", { threadId: "a" }).then(() => { result = "resolved"; }, () => { result = "rejected"; });
    await flush(); await f.transport.close().catch(e => { closeError = e; }); await flush();
    assert.equal(client.getPendingRequestCount(), 0); assert.equal(result, "rejected"); assert.equal(closeError, undefined);
  } finally { remove(); if (cordis) await cordis.dispose(); else await client.close(); }
});


test("actual WebSocket status chaos corpus preserves connection and publication owners", async () => {
  for (let seed = 0; seed < 24; seed++) await simulateTransportStatus(generateTransportChaos(seed, 120));
});
for (const [mutant, rule, types] of [
  ["orphan-connect", "STATUS_CONNECT_SETTLEMENT", ["begin", "open"]],
  ["stale-token", "STATUS_DELIVERY", ["rotate-a", "old-a", "begin"]],
  ["stale-status", "STATUS_CURRENT", ["begin", "open", "close"]],
  ["drop-peer", "STATUS_DELIVERY", ["close"]],
] as const) test(`transport chaos rejects ${mutant} at its exact rule and replays normally`, async () => {
  const events: TransportChaosEvent[] = types.map(type => ({ type }));
  await assert.rejects(simulateTransportStatus(events, { mutant }), (e: unknown) => e instanceof ChaosViolation && e.rule === rule && !e.cleanupFailure);
  const minimal = await shrinkChaosFailure(events, rule, trace => simulateTransportStatus(trace, { mutant: mutant as TransportChaosMutant }));
  await simulateTransportStatus(minimal);
});
test("transport heal is explicit and an empty trace creates no physical connection", async () => {
  const empty = await simulateTransportStatus([], { mutant: "orphan-connect" });
  assert.equal(empty.nativeEvents, 0); assert.equal(empty.connectIntents, 0);
  const trace = generateTransportChaos(0, 4); assert.equal(trace.length, 5); assert.equal(trace.at(-1)?.type, "heal");
  assert.throws(() => parseTransportTrace([{ type: "invented" }]));
});

for (const kind of ["memory", "websocket", "replay"] as const) test(`terminal ${kind} publication survives a synchronous successor connection`, async () => {
  const f = statusTransportFixture(kind); let successor: Promise<void> | undefined, entered = false;
  const seen: string[] = [];
  const a = f.transport.subscribeStatus(s => {
    if (s.state === "closed" && !entered) { entered = true; successor = f.transport.connect(); void successor.catch(() => {}); }
  });
  const b = f.transport.subscribeStatus(s => { seen.push(s.state); });
  try {
    await f.connect(); seen.length = 0; await f.transport.close(); await flush();
    assert.equal(seen.filter(s => s === "closed").length, 1, "the retired physical owner must notify its remaining consumers even after reconnect starts");
    const nextOpen = seen.indexOf("open");
    assert.ok(nextOpen === -1 || seen.indexOf("closed") < nextOpen, JSON.stringify(seen));
  } finally { a(); b(); await f.close(); await successor?.catch(() => {}); }
});

test("terminal Deferred publication is delivered before permanent observer cleanup", async () => {
  const f = statusTransportFixture("deferred"); let closing: Promise<void> | undefined, terminal = 0;
  const a = f.transport.subscribeStatus(s => { if (s.state === "open") closing = f.transport.close(); });
  const b = f.transport.subscribeStatus(s => { if (s.state === "closed") terminal++; });
  try { await f.connect().catch(() => {}); await closing; await flush(); assert.equal(terminal, 1); }
  finally { a(); b(); await f.close(); }
});

test("terminal Client retirement begins at closing before the physical close acknowledgement", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const transport = new MemoryTransport({ server: {
    receive(frame, peer) {
      const r = JSON.parse(frame);
      if (r.method === "initialize") peer.send(JSON.stringify({ id: r.id, result: { codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "closing-boundary" } }));
    },
    disconnected: () => barrier,
  } });
  const client = new JsonRpcAppServerClient({ hostId: "closing-boundary", transport }); let outcome = "pending", closing: Promise<void> | undefined;
  try {
    await client.connect({ clientInfo: { name: "closing-boundary", version: "1" } });
    void client.requestRaw("fixture/held", {}).then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
    await flush(); closing = transport.close(); await flush();
    assert.equal(transport.status.state, "closing"); assert.equal(outcome, "rejected"); assert.equal(client.getPendingRequestCount(), 0);
  } finally { release(); await closing; await client.close(); }
});

for (const kind of ["memory", "replay"] as const) test(`terminal ${kind} queue captures admission before a successor peer is replaced`, async () => {
  const f = statusTransportFixture(kind); let entered = false, replacement = false, current = () => {}, successor: Promise<void> | undefined;
  const observed: string[] = [];
  const b = (s: TransportStatus) => { if (replacement) observed.push(s.state); };
  const a = f.transport.subscribeStatus(s => {
    if (s.state === "closed" && !entered) {
      entered = true; successor = f.transport.connect(); void successor.catch(() => {});
      current(); replacement = true; current = f.transport.subscribeStatus(b);
    }
  });
  current = f.transport.subscribeStatus(b);
  try {
    await f.connect(); observed.length = 0; await f.transport.close(); await successor; await flush();
    assert.equal(observed.filter(s => s === (kind === "memory" ? "connecting" : "open")).length, 1,
      "the new peer gets its current sample, never a queued publication admitted before it existed");
  } finally { a(); current(); await f.close(); }
});

test("terminal observer reconnect cannot place the successor Client initialization in the old failure slot", async () => {
  let native!: import("@opencraft/appserver-transport-memory").InMemoryAppServerPeer, initializes = 0;
  const transport = new MemoryTransport({ server: { receive(frame, peer) {
    native = peer; const r = JSON.parse(frame);
    if (r.method === "initialize") {
      initializes++; peer.send(JSON.stringify({ id: r.id, result: { codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "reentrant-initialization" } }));
    }
  } } });
  const params = { clientInfo: { name: "reentrant-initialization", version: "1" } };
  let successor: Promise<unknown> | undefined, entered = false;
  const remove = transport.subscribeStatus(s => {
    if (s.state === "closed" && !entered) { entered = true; successor = client.connect(params); void successor.catch(() => {}); }
  });
  const client = new JsonRpcAppServerClient({ hostId: "reentrant-initialization", transport });
  try {
    await client.connect(params); native.close("Synthetic native loss"); await flush();
    assert.ok(successor); await assert.doesNotReject(successor); assert.equal(initializes, 2); assert.equal(client.connectionGeneration, 2);
  } finally { remove(); await client.close(); }
});
