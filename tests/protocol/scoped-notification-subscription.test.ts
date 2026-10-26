import assert from "node:assert/strict";
import test from "node:test";
import { createCordisAppServerClient, JsonRpcAppServerClient, type AppServerClient } from "@opencraft/appserver-client";
import { executionChannelsFixture, flush } from "./fixtures/execution-channels";
import { generateFanoutChaos, parseFanoutTrace, simulateNotificationFanout, type FanoutChaosEvent } from "./fixtures/notification-fanout-chaos";
import { ChaosViolation, shrinkChaosFailure } from "./fixtures/recovery-chaos";

for (const facade of [false, true]) test(`scoped notification delivery stays local and isolated through ${facade ? "Cordis" : "raw Client"}`, async () => {
  const f = executionChannelsFixture(), cordis = facade ? await createCordisAppServerClient({ hostId: "h", transport: f.transport }) : null;
  const client: AppServerClient = cordis?.client ?? new JsonRpcAppServerClient({ hostId: "h", transport: f.transport });
  await client.connect({ clientInfo: { name: "scoped-notifications", version: "1" } });
  const global: string[] = [], scoped: string[] = [], deferred: (() => void)[] = [], errors: Error[] = [];
  const removeGlobal = client.subscribeNotification(n => global.push(n.method));
  const removeError = client.subscribeProtocolError(e => errors.push(e));
  const remove = client.subscribeNotification(n => { scoped.push(n.method); if (n.method === "fixture/bad") throw Error("Synthetic deferred failure"); }, { intercept: (_n, next) => deferred.push(next) });
  try {
    f.emit("fixture/bad", { threadId: "a" }); f.emit("fixture/good", { threadId: "a" }); await flush();
    assert.deepEqual(global, ["fixture/bad", "fixture/good"]); assert.deepEqual(scoped, []);
    assert.doesNotThrow(() => deferred[0]!()); assert.equal(errors.length, 1);
    deferred[0]!(); assert.equal(errors.length, 2, "duplicate delivery is reported without invoking the consumer again");
    deferred[1]!(); assert.deepEqual(scoped, ["fixture/bad", "fixture/good"]); assert.equal(global.length, 2);
    f.emit("fixture/retired", { threadId: "a" }); await flush(); remove(); deferred[2]!();
    assert.equal(scoped.length, 2, "unsubscribed consumers cannot be revived by an old continuation"); assert.equal(errors.length, 2);
  } finally { remove(); removeGlobal(); removeError(); if (cordis) await cordis.dispose(); else await client.close(); }
});

test("a retained subscription cannot project an old physical generation", async () => {
  const f = executionChannelsFixture(), client = new JsonRpcAppServerClient({ hostId: "h", transport: f.transport });
  const initialize = { clientInfo: { name: "scoped-generation", version: "1" } }; await client.connect(initialize);
  const deferred: (() => void)[] = [], projected: string[] = [];
  const remove = client.subscribeNotification(n => projected.push(n.method), { intercept: (_n, next) => deferred.push(next) });
  try {
    f.emit("fixture/old", { threadId: "a" }); await flush(); const generation = client.connectionGeneration;
    await f.transport.close(); await client.connect(initialize); assert.notEqual(client.connectionGeneration, generation);
    f.emit("fixture/current", { threadId: "a" }); await flush(); deferred[0]!(); deferred[1]!();
    assert.deepEqual(projected, ["fixture/current"]);
  } finally { remove(); await client.close(); }
});

test("a failing subscription interceptor cannot prevent another native consumer", async () => {
  const f = executionChannelsFixture(), client = new JsonRpcAppServerClient({ hostId: "h", transport: f.transport });
  await client.connect({ clientInfo: { name: "interceptor-isolation", version: "1" } }); const native: string[] = [], errors: Error[] = [];
  const remove = client.subscribeNotification(() => { throw Error("unreachable"); }, { intercept() { throw Error("Synthetic subscription gate failure"); } });
  const removeNative = client.subscribeNotification(n => native.push(n.method)), removeError = client.subscribeProtocolError(e => errors.push(e));
  try { f.emit("fixture/observation", { threadId: "a" }); await flush(); assert.deepEqual(native, ["fixture/observation"]); assert.equal(errors.length, 1); }
  finally { remove(); removeNative(); removeError(); await client.close(); }
});

for (const facade of [false, true]) for (const scoped of [false, true]) {
  const name = `${facade ? "Cordis" : "raw Client"}, ${scoped ? "scoped" : "native"} listener`;
  const options = scoped ? { intercept: (_notification: unknown, next: () => void) => next() } : undefined;
  async function withClient(run: (client: AppServerClient, fixture: ReturnType<typeof executionChannelsFixture>) => Promise<void>) {
    const fixture = executionChannelsFixture();
    const cordis = facade ? await createCordisAppServerClient({ hostId: "h", transport: fixture.transport }) : null;
    const client = cordis?.client ?? new JsonRpcAppServerClient({ hostId: "h", transport: fixture.transport });
    try {
      await client.connect({ clientInfo: { name: "notification-admission", version: "1" } });
      await run(client, fixture);
    } finally { if (cordis) await cordis.dispose(); else await client.close(); }
  }

  test(`one event cannot repeatedly visit a re-subscribing callback: ${name}`, async () => withClient(async (client, f) => {
    let calls = 0, peer = 0, remove = () => {};
    const listener = () => {
      calls++;
      // A finite old-code counterexample; never let a failing test spin forever.
      if (calls < 4) { remove(); remove = client.subscribeNotification(listener, options); }
    };
    remove = client.subscribeNotification(listener, options);
    const removePeer = client.subscribeNotification(() => peer++);
    try {
      f.emit("fixture/one-input", {}); await flush();
      assert.equal(calls, 1, "the dispatch admission set cannot grow through callback reentry");
      assert.equal(peer, 1);
      f.emit("fixture/next-input", {}); await flush();
      assert.equal(calls, 2, "the successor receives the next real input"); assert.equal(peer, 2);
    } finally { remove(); removePeer(); }
  }));

  test(`replacing an unvisited peer cannot inherit its pending event: ${name}`, async () => withClient(async (client, f) => {
    let calls = 0, replaced = false, removePeer = () => {};
    const peer = () => calls++;
    const removeFirst = client.subscribeNotification(() => {
      if (!replaced) { replaced = true; removePeer(); removePeer = client.subscribeNotification(peer, options); }
    });
    removePeer = client.subscribeNotification(peer, options);
    try {
      f.emit("fixture/before-replacement", {}); await flush(); assert.equal(calls, 0);
      f.emit("fixture/after-replacement", {}); await flush(); assert.equal(calls, 1);
    } finally { removeFirst(); removePeer(); }
  }));

  test(`transport-wide deferral retains the original admitted subscriptions: ${name}`, async () => withClient(async (client, f) => {
    const deferred: (() => void)[] = [], observed: string[] = [];
    const removeGate = client.interceptNotification((_notification, next) => deferred.push(next));
    let remove = client.subscribeNotification(n => observed.push(`old:${n.method}`), options);
    try {
      f.emit("fixture/old", {}); await flush();
      remove(); remove = client.subscribeNotification(n => observed.push(`new:${n.method}`), options);
      deferred[0]!(); assert.deepEqual(observed, [], "a replacement cannot receive an event admitted before it existed");
      f.emit("fixture/new", {}); await flush(); deferred[1]!();
      assert.deepEqual(observed, ["new:fixture/new"]);
    } finally { removeGate(); remove(); }
  }));

  test(`a lost connection retires a globally deferred event before reinitialization: ${name}`, async () => withClient(async (client, f) => {
    const deferred: (() => void)[] = [], observed: string[] = [];
    const removeGate = client.interceptNotification((_notification, next) => deferred.push(next));
    const remove = client.subscribeNotification(n => observed.push(n.method), options);
    try {
      f.emit("fixture/lost", {}); await flush(); const generation = client.connectionGeneration;
      await f.transport.close(); assert.equal(client.connectionGeneration, generation, "no successor initialization has committed yet");
      deferred[0]!(); assert.deepEqual(observed, [], "physical loss revokes delivery without waiting for a generation increment");
    } finally { removeGate(); remove(); }
  }));
}

for (const facade of [false, true]) test(`native deduplication and unsubscribe tokens retain incarnation ownership through ${facade ? "Cordis" : "raw Client"}`, async () => {
  const f = executionChannelsFixture(), cordis = facade ? await createCordisAppServerClient({ hostId: "h", transport: f.transport }) : null;
  const client = cordis?.client ?? new JsonRpcAppServerClient({ hostId: "h", transport: f.transport });
  await client.connect({ clientInfo: { name: "native-subscription-incarnation", version: "1" } });
  let calls = 0; const listener = () => calls++;
  const removeOriginal = client.subscribeNotification(listener), removeDuplicate = client.subscribeNotification(listener);
  let removeSuccessor = () => {};
  try {
    f.emit("fixture/deduplicated", {}); await flush(); assert.equal(calls, 1, "native same-function registration keeps its existing Set deduplication");
    removeOriginal(); removeSuccessor = client.subscribeNotification(listener);
    removeDuplicate(); removeOriginal();
    f.emit("fixture/successor", {}); await flush(); assert.equal(calls, 2, "retired handles cannot remove a new registration of the same function");
  } finally { removeOriginal(); removeDuplicate(); removeSuccessor(); if (cordis) await cordis.dispose(); else await client.close(); }
});

test("a scoped deferred continuation is revoked at physical loss, before the next initialization", async () => {
  const f = executionChannelsFixture(), client = new JsonRpcAppServerClient({ hostId: "h", transport: f.transport });
  await client.connect({ clientInfo: { name: "scoped-loss-window", version: "1" } });
  const deferred: (() => void)[] = [], observed: string[] = [];
  const remove = client.subscribeNotification(n => observed.push(n.method), { intercept: (_n, next) => deferred.push(next) });
  try {
    f.emit("fixture/lost", {}); await flush(); const generation = client.connectionGeneration;
    await f.transport.close(); assert.equal(client.connectionGeneration, generation);
    deferred[0]!(); assert.deepEqual(observed, []);
  } finally { remove(); await client.close(); }
});

test("notification fanout chaos exercises registration churn, reentry and connection loss", async () => {
  assert.deepEqual(generateFanoutChaos(42), generateFanoutChaos(42));
  const totals: Record<string, number> = {};
  const witnesses: FanoutChaosEvent[][] = [
    ["hold-scoped", "wire", "loss", "release", "connect", "wire"].map(type => ({ type: type as FanoutChaosEvent["type"] })),
    ["reenter-peer", "wire", "reenter-self", "wire", "reenter-loss", "wire"].map(type => ({ type: type as FanoutChaosEvent["type"] })),
  ];
  for (const trace of [...witnesses, ...Array.from({ length: 8 }, (_, seed) => generateFanoutChaos(seed))]) {
    const result = await simulateNotificationFanout(trace);
    for (const [key, value] of Object.entries(result.coverage)) totals[key] = (totals[key] ?? 0) + value;
  }
  for (const key of ["wire-input", "delivery-a", "delivery-b", "effective-dedup", "retired-token-with-successor", "global-deferral", "scoped-deferral", "effective-self-reentry", "effective-peer-reentry", "effective-loss-reentry", "effective-connect"]) assert.ok(totals[key], key);
});
for (const [mutant, prefix, rule] of [
  ["live-admission", ["reenter-self", "wire"], "FANOUT_ADMISSION"],
  ["stale-token", ["rotate-a", "old-token-a", "wire"], "FANOUT_CONSERVED"],
  ["lost-continuation", ["hold-scoped", "wire", "loss", "release"], "FANOUT_PHYSICAL"],
] as const) test(`fanout chaos detects ${mutant}, shrinks its exact rule and replays normally`, async () => {
  const trace: FanoutChaosEvent[] = ["pad", ...prefix, "pad"].map(type => ({ type }));
  const run = (events: readonly FanoutChaosEvent[]) => simulateNotificationFanout(events, { mutant });
  const exact = (error: unknown) => error instanceof ChaosViolation && error.rule === rule && error.cleanupFailure === undefined;
  await assert.rejects(run(trace), exact);
  const minimal = await shrinkChaosFailure(trace, rule, run); await assert.rejects(run(minimal), exact);
  await simulateNotificationFanout(parseFanoutTrace(minimal));
});
test("fanout replay rejects unknown events and non-arrays", () => {
  assert.throws(() => parseFanoutTrace(null)); assert.throws(() => parseFanoutTrace([{ type: "invented" }]));
});
