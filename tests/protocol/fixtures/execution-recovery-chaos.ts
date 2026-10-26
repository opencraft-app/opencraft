import { isDeepStrictEqual } from "node:util";
import type { JsonRpcId } from "@opencraft/appserver-protocol";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { createCordisThreadSessionRuntime } from "@opencraft/appserver-session";
import { AppServerInteractionBroker, encodeServerRequestId } from "@opencraft/composer-appserver";
import { executionChannelsFixture, flush } from "./execution-channels";
import { ChaosViolation, requireThat } from "./recovery-chaos";

export type ExecutionChaosEvent = { type: "read" | "cancel" | "release" | "settings" | "question" | "resolve" | "wrong-resolve" | "answer" | "pad"; value: number };
export function parseExecutionTrace(value: unknown): ExecutionChaosEvent[] {
  if (!Array.isArray(value) || value.length > 10001) throw Error("Invalid execution trace");
  return value.map(event => {
    if (!event || !["read", "cancel", "release", "settings", "question", "resolve", "wrong-resolve", "answer", "pad"].includes(event.type)
      || !Number.isSafeInteger(event.value) || event.value < 0 || event.value > 0xffffffff) throw Error("Invalid execution event");
    return { type: event.type, value: event.value };
  });
}
export function generateExecutionChaos(seed: number, steps = 120): ExecutionChaosEvent[] {
  let state = seed >>> 0; const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const types: ExecutionChaosEvent["type"][] = ["read", "cancel", "release", "settings", "question", "resolve", "wrong-resolve", "answer", "pad"];
  return Array.from({ length: steps }, () => ({ type: types[next() % types.length]!, value: next() }));
}
export type ExecutionChaosMutant = "buffer-native" | "buffer-settings" | "wrong-native-answer" | "wrong-response-id" | "history-gated-response";
export interface ExpectedNativeResponse {
  readonly id: JsonRpcId;
  readonly result: { readonly answers: Readonly<Record<string, { readonly answers: readonly string[] }>> };
}

/** Wire evidence is independent of the Broker's result projection. Object key
 * order is irrelevant; request id types, answer values/order and errors are not. */
export function inspectNativeResponses(received: readonly unknown[], expected: readonly ExpectedNativeResponse[]): void {
  requireThat(received.length === expected.length, "NATIVE_RESPONSE", "only explicit current responses may emit one native response");
  for (let i = 0; i < expected.length; i++) {
    const response = received[i], wanted = expected[i]!;
    requireThat(typeof response === "object" && response !== null && "id" in response && response.id === wanted.id,
      "NATIVE_RESPONSE_ID", "a native answer must retain the exact typed request id");
    requireThat(isDeepStrictEqual(response, wanted), "NATIVE_CONTENT", "the wire response must contain exactly the human's current answer");
  }
}

/** This fixture has an immediately cooperative native transport and no external
 * I/O. Drain its known event-loop turns; do not wait for a broken operation to
 * settle before reporting non-progress, and do not use wall-clock deadlines. */
async function settleFixtureOperation(operation: Promise<unknown>, rule: string, boundary: string): Promise<void> {
  const observed: { settled: boolean; failed: boolean; error?: unknown } = { settled: false, failed: false };
  void operation.then(() => { observed.settled = true; }, error => { observed.settled = true; observed.failed = true; observed.error = error; });
  await flush();
  requireThat(observed.settled, rule, `${boundary} did not settle under cooperative native fixture processing`);
  if (observed.failed) throw observed.error;
}

export async function simulateExecutionRecovery(events: readonly ExecutionChaosEvent[], options: { mutant?: ExecutionChaosMutant } = {}) {
  const f = executionChannelsFixture(), client = new JsonRpcAppServerClient({ hostId: "h", transport: f.transport });
  await client.connect({ clientInfo: { name: "execution-chaos", version: "1" } });
  let reading: { controller: AbortController; promise: Promise<unknown> } | null = null;
  const postponed: (() => void)[] = [];
  // Deliberate old-owner controls use the actual client interceptor path.
  if (options.mutant === "buffer-native") client.interceptServerRequest((_request, next) => reading
    ? new Promise((resolve, reject) => { postponed.push(() => void next().then(resolve, reject)); }) : next());
  if (options.mutant === "buffer-settings") client.interceptNotification((notification, next) => {
    if (reading && notification.method === "thread/settings/updated") postponed.push(next); else next();
  });
  if (options.mutant === "wrong-native-answer" || options.mutant === "history-gated-response") client.interceptServerRequest(async (_request, next) => {
    const result = await next();
    if (options.mutant === "wrong-native-answer") return { answers: { choice: { answers: ["wrong-synthetic-choice"] } } };
    if (reading) await new Promise<void>(resolve => { postponed.push(resolve); });
    return result;
  });
  if (options.mutant === "wrong-response-id") {
    const send = f.transport.send.bind(f.transport);
    f.transport.send = frame => {
      const message = JSON.parse(frame);
      if (message.method === undefined && Object.hasOwn(message, "result")) message.id = typeof message.id === "number" ? String(message.id) : Number(message.id);
      return send(JSON.stringify(message));
    };
  }
  const session = await createCordisThreadSessionRuntime({ client, historyModeHint: "message-window" });
  const broker = new AppServerInteractionBroker({ hostId: "h", client, store: session.views });
  const pending = new Map<string, string | number>(), coverage: Record<string, number> = {};
  let model = "old", answered = 0, reads = 0, incarnation = 0;
  let primaryFailure: unknown;
  const expectedResponses: ExpectedNativeResponse[] = [];
  const count = (name: string) => { coverage[name] = (coverage[name] ?? 0) + 1; };
  const idFor = (n: number) => n % 4 < 2 ? n % 2 : String(n % 2);
  const inspect = () => {
    const view = session.views.get("a");
    requireThat(view?.execution.model === model, "LIVE_SETTINGS", "history must not delay or erase native settings");
    const actual = view?.pendingInteractions.map(item => item.requestId).sort();
    requireThat(JSON.stringify(actual) === JSON.stringify([...pending.keys()].sort()), "NATIVE_REQUEST", "history cannot own question admission, cancellation or withdrawal");
    inspectNativeResponses(f.replies, expectedResponses);
  };
  const answer = async (id: JsonRpcId, key: string, answers: Readonly<Record<string, readonly string[]>>) => {
    // Build the oracle from the input intent, never by calling the production
    // response mapper or trusting what the transport happened to send.
    expectedResponses.push({ id, result: { answers: Object.fromEntries(Object.entries(answers).map(([question, values]) => [question, { answers: [...values] }])) } });
    const operation = broker.respond({ hostId: "h", threadId: "a" }, { type: "question", requestId: key, answers });
    await settleFixtureOperation(operation, "NATIVE_PROGRESS", "the current native answer");
  };
  try {
    await session.resume.read("a"); await session.resume.activate({ threadId: "a" }); f.hold = true;
    for (const event of events) {
      count(event.type);
      const id = idFor(event.value), key = encodeServerRequestId(id);
      if (event.type === "read" && !reading) {
        const controller = new AbortController();
        reading = { controller, promise: session.resume.read("a", { signal: controller.signal }).catch(() => undefined) }; reads++; count("effective-read");
      } else if (event.type === "cancel" && reading) {
        const old = reading; reading = null; old.controller.abort(); await settleFixtureOperation(old.promise, "HISTORY_RETIREMENT", "cancelled Read"); postponed.length = 0; count("effective-cancel");
      } else if (event.type === "release") {
        const old = reading; reading = null; f.release(); for (const run of postponed.splice(0)) run(); if (old) await settleFixtureOperation(old.promise, "HISTORY_RELEASE", "released Read");
      } else if (event.type === "settings") {
        model = `model-${event.value}`; f.settings(model); if (reading) count("settings-during-read");
      } else if (event.type === "question" && !pending.has(key)) {
        pending.set(key, id); f.question(id, `item-${++incarnation}`); count(typeof id + "-question"); if (reading) count("question-during-read");
      } else if (event.type === "resolve") {
        pending.delete(key); f.emit("serverRequest/resolved", { threadId: "a", requestId: id }); if (reading) count("withdraw-during-read");
      } else if (event.type === "wrong-resolve") {
        f.emit("serverRequest/resolved", { threadId: "other", requestId: id });
      } else if (event.type === "answer" && pending.has(key)) {
        await answer(id, key, { choice: [String(event.value)] });
        pending.delete(key); answered++; if (reading) count("answer-during-read");
      }
      await flush(); inspect();
    }
    // Only native execution is made fair first: history is deliberately held.
    for (const key of [...pending.keys()]) {
      await answer(pending.get(key)!, key, {});
      pending.delete(key); answered++; await flush(); inspect(); count("fair-native-answer");
    }
    const old = reading; reading = null; old?.controller.abort(); if (old) await settleFixtureOperation(old.promise, "HISTORY_RETIREMENT", "final Read retirement"); f.release(); await flush(); inspect();
    return { events: events.length + 1, coverage, historyRuns: reads, nativeReplies: answered };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const old = reading; reading = null; old?.controller.abort(); f.release(); for (const run of postponed.splice(0)) run();
    let cleanupFailure: unknown;
    for (const step of [
      () => old?.promise ?? Promise.resolve(),
      () => { broker.dispose(); return session.dispose(); },
      () => client.close(),
    ]) {
      try { await settleFixtureOperation(Promise.resolve().then(step), "FIXTURE_CLEANUP", "fixture cleanup"); }
      catch (error) { cleanupFailure ??= error; }
    }
    if (cleanupFailure !== undefined) {
      if (primaryFailure instanceof ChaosViolation) primaryFailure.cleanupFailure = String(cleanupFailure);
      else if (primaryFailure === undefined) throw cleanupFailure;
    }
  }
}
