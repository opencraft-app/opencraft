import assert from "node:assert/strict";
import test from "node:test";
import { createCordisAppServerClient, JsonRpcAppServerClient, type AppServerClient, type AppServerRequestLifecycleEvent } from "@opencraft/appserver-client";
import { executionChannelsFixture, flush } from "./fixtures/execution-channels";
import { generateObserverChaos, parseObserverTrace, simulateObserverAdmission, type ObserverChaosEvent } from "./fixtures/observer-admission-chaos";
import { ChaosViolation, shrinkChaosFailure } from "./fixtures/recovery-chaos";

type Lane = "diagnostic" | "lifecycle";
type Observation = Error | AppServerRequestLifecycleEvent;
async function fixture(facade: boolean, lane: Lane) {
  const f = executionChannelsFixture();
  const cordis = facade ? await createCordisAppServerClient({ hostId: "observer", transport: f.transport }) : null;
  const client: AppServerClient = cordis?.client ?? new JsonRpcAppServerClient({ hostId: "observer", transport: f.transport });
  await client.connect({ clientInfo: { name: "observer-admission", version: "1" } });
  const frames: string[] = [], send = f.transport.send.bind(f.transport);
  f.transport.send = (frame, signal) => { if (JSON.parse(frame).method === "fixture/observer") frames.push(frame); return send(frame, signal); };
  const removeBad = lane === "diagnostic" ? client.subscribeNotification(() => { throw Error("Synthetic observation source"); }) : () => {};
  return {
    client, frames, native: f,
    listener(callback: () => void) {
      return (event: Observation) => {
        if (lane === "diagnostic" ? event instanceof Error && event.cause instanceof Error && event.cause.message === "Synthetic observation source"
          : !(event instanceof Error) && "method" in event && event.method === "fixture/observer" && event.type === "queued") callback();
      };
    },
    subscribe(listener: (event: Observation) => void) {
      return lane === "diagnostic" ? client.subscribeProtocolError(listener) : client.subscribeRequestLifecycle(listener);
    },
    async emit(signal?: AbortSignal) {
      if (lane === "diagnostic") f.emit("fixture/observer-error", {});
      else await client.requestRaw("fixture/observer", {}, { signal });
      await flush();
    },
    async close() { removeBad(); if (cordis) await cordis.dispose(); else await client.close(); },
  };
}

for (const facade of [false, true]) for (const lane of ["diagnostic", "lifecycle"] as const) {
  const name = `${facade ? "Cordis" : "raw Client"} ${lane}`;
  test(`a finite re-subscribing observer receives each event once: ${name}`, async () => {
    const f = await fixture(facade, lane); let calls = 0, peer = 0, remove = () => {};
    const listener = f.listener(() => { calls++; if (calls < 4) { remove(); remove = f.subscribe(listener); } });
    remove = f.subscribe(listener); const removePeer = f.subscribe(f.listener(() => peer++));
    try {
      await f.emit(); assert.equal(calls, 1); assert.equal(peer, 1);
      await f.emit(); assert.equal(calls, 2); assert.equal(peer, 2);
    } finally { remove(); removePeer(); await f.close(); }
  });

  test(`native deduplication keeps retired unsubscribe tokens from a successor: ${name}`, async () => {
    const f = await fixture(facade, lane); let calls = 0, removeSuccessor = () => {};
    const listener = f.listener(() => calls++), first = f.subscribe(listener), duplicate = f.subscribe(listener);
    try {
      await f.emit(); assert.equal(calls, 1);
      first(); removeSuccessor = f.subscribe(listener); first(); duplicate();
      await f.emit(); assert.equal(calls, 2);
    } finally { first(); duplicate(); removeSuccessor(); await f.close(); }
  });

  test(`a replacement cannot inherit an unvisited observer's event: ${name}`, async () => {
    const f = await fixture(facade, lane); let calls = 0, replaced = false, removePeer = () => {};
    const peer = f.listener(() => calls++), removeFirst = f.subscribe(f.listener(() => {
      if (!replaced) { replaced = true; removePeer(); removePeer = f.subscribe(peer); }
    }));
    removePeer = f.subscribe(peer);
    try {
      await f.emit(); assert.equal(calls, 0);
      await f.emit(); assert.equal(calls, 1);
    } finally { removeFirst(); removePeer(); await f.close(); }
  });

  test(`an observer added during dispatch starts with the next event: ${name}`, async () => {
    const f = await fixture(facade, lane); let calls = 0, added = false, removeAdded = () => {};
    const removeFirst = f.subscribe(f.listener(() => { if (!added) { added = true; removeAdded = f.subscribe(f.listener(() => calls++)); } }));
    try { await f.emit(); assert.equal(calls, 0); await f.emit(); assert.equal(calls, 1); }
    finally { removeFirst(); removeAdded(); await f.close(); }
  });

  test(`a throwing observer cannot interrupt its peer or request completion: ${name}`, async () => {
    const f = await fixture(facade, lane); let peer = 0;
    const removeBad = f.subscribe(f.listener(() => { throw Error("Synthetic isolated observer error"); }));
    const removePeer = f.subscribe(f.listener(() => peer++));
    try { await f.emit(); assert.equal(peer, 1); assert.equal(f.frames.length, lane === "lifecycle" ? 1 : 0); }
    finally { removeBad(); removePeer(); await f.close(); }
  });

  test(`closing from an observer retires the original cut and queued request: ${name}`, async () => {
    const f = await fixture(facade, lane); let peer = 0, closing: Promise<void> | undefined;
    const removeFirst = f.subscribe(f.listener(() => { closing ??= f.client.close(); }));
    const removePeer = f.subscribe(f.listener(() => peer++));
    try {
      if (lane === "lifecycle") await assert.rejects(f.emit(), (e: any) => e.code === "CLOSED");
      else await f.emit();
      await closing; assert.equal(peer, 0); assert.equal(f.frames.length, 0); assert.equal(f.client.getPendingRequestCount(), 0);
    } finally { removeFirst(); removePeer(); await f.close(); }
  });
}

for (const facade of [false, true]) for (const phase of ["queued", "started"] as const) test(`a ${phase} observer can cancel without a native request through ${facade ? "Cordis" : "raw Client"}`, async () => {
  const f = await fixture(facade, "lifecycle"), controller = new AbortController(); let calls = 0;
  const remove = f.client.subscribeRequestLifecycle(event => {
    if ("method" in event && event.method === "fixture/observer" && event.type === phase) { calls++; controller.abort(); }
  });
  try { await assert.rejects(f.emit(controller.signal), (e: any) => e.code === "ABORTED"); assert.equal(calls, 1); assert.equal(f.frames.length, 0); assert.equal(f.client.getPendingRequestCount(), 0); }
  finally { remove(); await f.close(); }
});

for (const facade of [false, true]) test(`transport loss still publishes request termination through ${facade ? "Cordis" : "raw Client"}`, async () => {
  const f = await fixture(facade, "lifecycle"); f.native.hold = true;
  const failures: AppServerRequestLifecycleEvent[] = [];
  const remove = f.client.subscribeRequestLifecycle(event => {
    if ("method" in event && event.method === "thread/read" && event.type === "failed") failures.push(event);
  });
  const pending = f.client.request("thread/read", { threadId: "a" }); void pending.catch(() => {});
  try {
    await flush(); const generation = f.client.connectionGeneration;
    await f.native.transport.close();
    await assert.rejects(pending, (e: any) => e.code === "TRANSPORT_ERROR");
    assert.equal(f.client.connectionGeneration, generation);
    assert.equal(failures.length, 1, "observability remains current after physical loss without granting execution authority");
  } finally { remove(); f.native.release(); await f.close(); }
});

test("observer chaos covers diagnostic/lifecycle churn and preserves queued cancellation and termination", async () => {
  assert.deepEqual(generateObserverChaos(42), generateObserverChaos(42)); const totals: Record<string, number> = {};
  const traces: ObserverChaosEvent[][] = [
    ["reenter-self", "error", "reenter-peer", "error"],
    ["reenter-cancel", "request"],
    ["throw-observer", "request", "error"],
    ["reenter-close", "request"],
  ].map(events => events.map(type => ({ type: type as ObserverChaosEvent["type"] })));
  for (let seed = 0; seed < 8; seed++) traces.push(generateObserverChaos(seed));
  for (const trace of traces) {
    const result = await simulateObserverAdmission(trace);
    for (const [key, value] of Object.entries(result.coverage)) totals[key] = (totals[key] ?? 0) + value;
  }
  for (const key of ["diagnostic-emission", "lifecycle-emission", "delivery-da", "delivery-db", "delivery-la", "delivery-lb", "effective-self-reentry", "effective-peer-reentry", "effective-cancel-reentry", "effective-close-reentry", "isolated-observer-throw", "effective-dedup", "old-token-with-successor"]) assert.ok(totals[key], key);
});
for (const [mutant, traceTypes, rule] of [
  ["live-admission", ["reenter-self", "error"], "OBSERVER_ADMISSION"],
  ["stale-token", ["rotate-da", "old-da", "error"], "OBSERVER_CONSERVED"],
  ["drop-terminal", ["request"], "OBSERVER_TERMINAL"],
] as const) test(`observer chaos detects ${mutant}, shrinks the same rule and replays normally`, async () => {
  const trace: ObserverChaosEvent[] = ["pad", ...traceTypes, "pad"].map(type => ({ type }));
  const run = (events: readonly ObserverChaosEvent[]) => simulateObserverAdmission(events, { mutant });
  const exact = (e: unknown) => e instanceof ChaosViolation && e.rule === rule && e.cleanupFailure === undefined;
  await assert.rejects(run(trace), exact); const minimal = await shrinkChaosFailure(trace, rule, run);
  await assert.rejects(run(minimal), exact); await simulateObserverAdmission(parseObserverTrace(minimal));
});
test("observer replay rejects malformed traces", () => {
  assert.throws(() => parseObserverTrace(null)); assert.throws(() => parseObserverTrace([{ type: "invented" }]));
});

test("observer chaos checks close termination before clearing its reference registrations", async () => {
  const events: ObserverChaosEvent[] = [{ type: "reenter-close" }, { type: "request" }];
  await assert.rejects(simulateObserverAdmission(events, { mutant: "drop-terminal" }),
    (e: unknown) => e instanceof ChaosViolation && e.rule === "OBSERVER_TERMINAL" && e.cleanupFailure === undefined);
  await simulateObserverAdmission(events);
});
