import { JsonRpcAppServerClient, type ServerRequestHandler, type ServerRequestResponseContext } from "@opencraft/appserver-client";
import { executionChannelsFixture, flush } from "./execution-channels";
import { ChaosViolation, recoveryChaosRandom, requireThat } from "./recovery-chaos";

const types = ["register-a", "register-b", "old-token", "current-token", "question", "resolve-one", "withdraw-one", "reenter-replace", "reenter-remove", "throw-next", "close", "pad"] as const;
export type HandlerChaosEvent = { type: typeof types[number] };
export type HandlerChaosMutant = "stale-token" | "retarget-result" | "cancel-admitted";
export function parseHandlerTrace(value: unknown): HandlerChaosEvent[] {
  if (!Array.isArray(value) || value.length > 10001) throw Error("Invalid handler trace");
  return value.map(e => { if (!e || !types.includes(e.type)) throw Error("Invalid handler event"); return { type: e.type }; });
}
export function generateHandlerChaos(seed: number, steps = 120): HandlerChaosEvent[] {
  const random = recoveryChaosRandom(seed);
  // Closing near the end allows meaningful registration and pending-response churn.
  return Array.from({ length: steps }, (_, i) => ({ type: types[Math.floor(random() * (i < steps * 0.85 ? types.length - 2 : types.length))]! }));
}

/** One method, two stable callback functions, actual Client/MemoryTransport.
 * Expected registration and response owners are recorded at the external input
 * boundary; callbacks and replies are observed without reading the Client map. */
export async function simulateHandlerRegistration(events: readonly HandlerChaosEvent[], options: { mutant?: HandlerChaosMutant } = {}) {
  const f = executionChannelsFixture(), client = new JsonRpcAppServerClient({ hostId: "handler-chaos", transport: f.transport });
  await client.connect({ clientInfo: { name: "handler-chaos", version: "1" } });
  type Key = "a" | "b";
  type Registration = { id: number; key: Key; remove: () => void };
  type Request = { id: string; owner?: Registration; calls: number; state: "pending" | "answered" | "missing" | "withdrawn" | "lost" | "thrown";
    context?: ServerRequestResponseContext; resolve?: (value: unknown) => void; reject?: (error: Error) => void; released: boolean };
  let active: Registration | undefined, registrationId = 0, requestId = 0, closed = false;
  let reentry: "replace" | "remove" | undefined, throwNext = false, failure: unknown, callbackFailure: unknown;
  const tokens: Registration[] = [], requests: Request[] = [], coverage: Record<string, number> = {};
  const count = (key: string) => { coverage[key] = (coverage[key] ?? 0) + 1; };
  const answer = (owner?: Registration) => ({ answers: { choice: { answers: [String(owner?.id), owner?.key ?? "absent"] } } });
  const replies = () => f.replies as { id: string; result?: unknown; error?: unknown }[];
  const check = () => {
    if (callbackFailure) throw callbackFailure;
    for (const q of requests) {
      requireThat(q.calls === (q.owner ? 1 : 0), "HANDLER_ADMISSION", "each incoming request enters exactly the handler admitted for it");
      const found = replies().filter(r => r.id === q.id);
      requireThat(found.length <= 1, "HANDLER_ONCE", "one native request cannot acquire two response frames");
      if (q.state === "pending") {
        requireThat(!q.context?.signal.aborted && found.length === 0, "HANDLER_CONTEXT_OWNERSHIP", "registration changes cannot terminate an admitted native response");
      } else if (q.state === "answered") {
        requireThat(found.length === 1 && JSON.stringify(found[0]?.result) === JSON.stringify(answer(q.owner)), "HANDLER_REPLY_OWNER", "an admitted result belongs to its original handler owner");
      } else if (q.state === "missing" || q.state === "thrown") {
        requireThat(found.length === 1 && !!found[0]?.error, "HANDLER_ADMISSION", "missing or throwing handlers must terminate with one error");
      } else requireThat(found.length === 0 && q.context?.signal.aborted === true, "HANDLER_NATIVE_RETIREMENT", "withdrawn or lost requests cannot send late responses");
    }
    requireThat(replies().every(r => requests.some(q => q.id === r.id)), "HANDLER_ONCE", "a response must name an actual native input");
  };
  const remove = (token: Registration) => {
    const current = active;
    if (current === token) { active = undefined; count("effective-current-removal"); }
    else if (current) count("old-token-with-successor");
    if (options.mutant === "stale-token" && current && current !== token) current.remove();
    else token.remove();
    if (options.mutant === "cancel-admitted" && current === token) for (const q of requests) {
      if (q.state === "pending") q.reject?.(Error("Synthetic registration-owned cancellation"));
    }
  };
  const callbacks = Object.fromEntries((["a", "b"] as const).map(key => [key, ((_p, request, context) => {
    const q = requests.find(q => q.id === request.id);
    try { requireThat(!!q && q.owner?.key === key && q.calls++ === 0, "HANDLER_ADMISSION", "the handler must match the input admission cut"); }
    catch (error) { callbackFailure ??= error; throw error; }
    if (!q) throw Error("Unrecorded native request");
    q.context = context; count("handler-entry");
    const action = reentry; reentry = undefined;
    if (action === "replace") { register(key); count("effective-reentrant-replacement"); }
    if (action === "remove" && active) { remove(active); count("effective-reentrant-removal"); }
    if (throwNext) { throwNext = false; q.state = "thrown"; count("handler-throw"); throw Error("Synthetic handler failure"); }
    return new Promise((resolve, reject) => { q.resolve = resolve; q.reject = reject; });
  }) satisfies ServerRequestHandler])) as Record<Key, ServerRequestHandler>;
  function register(key: Key) {
    if (closed) return;
    if (active?.key === key) count("same-function-replacement");
    active = { id: ++registrationId, key, remove: client.handleServerRequest("item/tool/requestUserInput", callbacks[key]) };
    tokens.push(active); count("registration");
  }
  const question = async () => {
    if (closed) return;
    const q: Request = { id: `question-${++requestId}`, owner: active, calls: 0, state: active ? "pending" : "missing", released: false };
    requests.push(q); f.question(q.id); count("native-question"); await flush(); check();
  };
  const release = async (q: Request) => {
    q.released = true;
    if (q.state === "pending") q.state = "answered";
    q.resolve?.(answer(options.mutant === "retarget-result" && active ? active : q.owner));
    count("handler-completion"); await flush(); check();
  };
  try {
    register("a");
    for (const e of events) {
      count(e.type);
      if (closed) continue;
      if (e.type === "register-a" || e.type === "register-b") register(e.type === "register-a" ? "a" : "b");
      else if (e.type === "old-token" && tokens.length) remove(tokens[0]!);
      else if (e.type === "current-token" && active) remove(active);
      else if (e.type === "question") await question();
      else if (e.type === "resolve-one") { const q = requests.find(q => q.resolve && !q.released); if (q) await release(q); }
      else if (e.type === "withdraw-one") {
        const q = requests.find(q => q.state === "pending");
        if (q) { q.state = "withdrawn"; f.emit("serverRequest/resolved", { threadId: "a", requestId: q.id }); count("effective-withdrawal"); }
      } else if (e.type === "reenter-replace") reentry = "replace";
      else if (e.type === "reenter-remove") reentry = "remove";
      else if (e.type === "throw-next") throwNext = true;
      else if (e.type === "close") {
        closed = true; for (const q of requests) if (q.state === "pending") q.state = "lost";
        active = undefined; await client.close(); count("effective-close");
      }
      await flush(); check();
    }
    // Probe the existing registration before installing a fresh one: otherwise
    // a healthy suffix could conceal a stale token deleting its successor.
    const drain = async () => { for (const q of requests) if (q.resolve && !q.released) await release(q); };
    if (!closed) await question();
    await drain();
    // Finish existing work before the fresh-owner probe, so the suffix itself
    // does not manufacture an outstanding result crossing a registration change.
    if (!closed) { register("a"); await question(); await drain(); }
    check();
    return { events: events.length, nativeEvents: requests.length, nativeReplies: replies().length, coverage };
  } catch (error) { failure = error; throw error; }
  finally {
    try { await client.close(); for (const q of requests) q.resolve?.(answer(q.owner)); await flush(); }
    catch (error) { if (failure === undefined) throw error; if (failure instanceof ChaosViolation) failure.cleanupFailure = String(error); }
  }
}
