import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { createCordisThreadSessionRuntime } from "@opencraft/appserver-session";
import { AppServerInteractionBroker, encodeServerRequestId } from "@opencraft/composer-appserver";
import { executionChannelsFixture, flush } from "./execution-channels";
import { requireThat } from "./recovery-chaos";

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
export async function simulateExecutionRecovery(events: readonly ExecutionChaosEvent[], options: { mutant?: "buffer-native" | "buffer-settings" } = {}) {
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
  const session = await createCordisThreadSessionRuntime({ client, historyModeHint: "message-window" });
  const broker = new AppServerInteractionBroker({ hostId: "h", client, store: session.views });
  const pending = new Map<string, string | number>(), coverage: Record<string, number> = {};
  let model = "old", answered = 0, reads = 0, incarnation = 0;
  const count = (name: string) => { coverage[name] = (coverage[name] ?? 0) + 1; };
  const idFor = (n: number) => n % 4 < 2 ? n % 2 : String(n % 2);
  const inspect = () => {
    const view = session.views.get("a");
    requireThat(view?.execution.model === model, "LIVE_SETTINGS", "history must not delay or erase native settings");
    const actual = view?.pendingInteractions.map(item => item.requestId).sort();
    requireThat(JSON.stringify(actual) === JSON.stringify([...pending.keys()].sort()), "NATIVE_REQUEST", "history cannot own question admission, cancellation or withdrawal");
    requireThat(f.replies.length === answered, "NATIVE_RESPONSE", "only explicit current responses may emit one native response");
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
        const old = reading; reading = null; old.controller.abort(); await old.promise; postponed.length = 0; count("effective-cancel");
      } else if (event.type === "release") {
        const old = reading; reading = null; f.release(); for (const run of postponed.splice(0)) run(); await old?.promise;
      } else if (event.type === "settings") {
        model = `model-${event.value}`; f.settings(model); if (reading) count("settings-during-read");
      } else if (event.type === "question" && !pending.has(key)) {
        pending.set(key, id); f.question(id, `item-${++incarnation}`); count(typeof id + "-question"); if (reading) count("question-during-read");
      } else if (event.type === "resolve") {
        pending.delete(key); f.emit("serverRequest/resolved", { threadId: "a", requestId: id }); if (reading) count("withdraw-during-read");
      } else if (event.type === "wrong-resolve") {
        f.emit("serverRequest/resolved", { threadId: "other", requestId: id });
      } else if (event.type === "answer" && pending.has(key)) {
        const response = broker.respond({ hostId: "h", threadId: "a" }, { type: "question", requestId: key, answers: { choice: [String(event.value)] } });
        await response; pending.delete(key); answered++; if (reading) count("answer-during-read");
      }
      await flush(); inspect();
    }
    // Only native execution is made fair first: history is deliberately held.
    for (const key of [...pending.keys()]) {
      await broker.respond({ hostId: "h", threadId: "a" }, { type: "question", requestId: key, answers: {} });
      pending.delete(key); answered++; await flush(); inspect(); count("fair-native-answer");
    }
    const old = reading; reading = null; old?.controller.abort(); await old?.promise; f.release(); await flush(); inspect();
    return { events: events.length + 1, coverage, historyRuns: reads, nativeReplies: answered };
  } finally {
    const old = reading; reading = null; old?.controller.abort(); f.release(); for (const run of postponed.splice(0)) run(); await old?.promise;
    broker.dispose(); await session.dispose(); await client.close();
  }
}
