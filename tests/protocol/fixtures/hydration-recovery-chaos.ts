import { ThreadResumeCoordinatorService } from "@opencraft/appserver-session";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
import { createAppServerWorkbenchRuntime, type AppServerThreadRuntimeLease } from "@opencraft/workbench-runtime";
import { ChaosViolation, requireThat, recoveryChaosRandom } from "./recovery-chaos";

type Thread = "a" | "b";
export type HydrationChaosEvent = { type: "acquire" | "release" | "retry" | "reply"; thread: Thread }
  | { type: "reconnect" | "flush" };
export interface HydrationChaosOptions { mutant?: "sticky-read"; legacy?: boolean }
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** Real Workbench -> Binding -> Session -> RPC composition. Old RPC replies
 * may be withheld forever; only new requests in the final healthy suffix reply. */
export async function simulateHydrationRecovery(events: readonly HydrationChaosEvent[], options: HydrationChaosOptions = {}) {
  const coverage: Record<string, number> = {}, count = (key: string) => { coverage[key] = (coverage[key] ?? 0) + 1; };
  const leases = new Map<Thread, AppServerThreadRuntimeLease>();
  const replies: { thread: Thread; epoch: number; done: boolean; send(): void }[] = [];
  const callers: { settled: boolean }[] = [];
  let epoch = 0, healthy = false, initialized = 0, closes = 0;
  const originalRead = ThreadResumeCoordinatorService.prototype.read;
  if (options.mutant) {
    const sticky = new WeakMap<ThreadResumeCoordinatorService, Map<string, ReturnType<typeof originalRead>>>();
    ThreadResumeCoordinatorService.prototype.read = function (id, input = {}) {
      let slots = sticky.get(this); if (!slots) { slots = new Map(); sticky.set(this, slots); }
      if (!slots.has(id)) slots.set(id, originalRead.call(this, id, { ...input, signal: undefined }));
      return slots.get(id)!;
    };
  }
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
    const send = (result: unknown) => peer.send(encodeJsonRpcMessage({ id: request.id, result }));
    if (request.method === "initialize") {
      initialized++;
      send({ codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "hydration-chaos",
        ...(options.legacy ? { capabilities: { extensions: { "opencraft/message-window-history": { version: 1 },
          "opencraft/resume-history": { version: 1, mode: "message-window" } } } } : {}) });
    } else if (request.method === "thread/read" || request.method === "thread/resume") {
      const thread = (request.params as { threadId: Thread }).threadId;
      const tag = `${thread}-epoch-${epoch}`, receivedEpoch = epoch;
      const turn = { id: `turn-${thread}`, status: "completed", itemsView: "full", items: [{ id: `item-${thread}`, type: "agentMessage", text: tag, phase: "final_answer" }], error: null };
      const reply = { thread, epoch: receivedEpoch, done: false, send() {
        if (this.done) return; this.done = true;
        if (this.epoch < epoch) count("retired-reply");
        send({ thread: { id: thread, sessionId: thread, name: thread, path: `/rollouts/${thread}`, cwd: "/workspace", historyMode: options.legacy ? "message-window" : "paginated", turns: [] },
          model: "fixture", modelProvider: "fixture", cwd: "/workspace", runtimeWorkspaceRoots: [], approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: {},
          initialTurnsPage: { data: [turn], nextCursor: null }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
      } };
      replies.push(reply); count("history-request");
      if (replies.some(other => other !== reply && other.thread === thread && !other.done && other.epoch < epoch)) count("new-before-old-reply");
      if (healthy) reply.send();
    } else if (request.method.endsWith("/list")) send({ data: [], nextCursor: null });
    else { requireThat(!["turn/start", "turn/steer", "thread/start"].includes(request.method), "HYDRATION_NO_REPLAY", request.method); send({}); }
  } });
  const close = transport.close.bind(transport); transport.close = async () => { closes++; await close(); };
  const runtime = createAppServerWorkbenchRuntime({ hostId: "hydration-chaos", transport, autoReconnect: false, requestTimeoutMs: 60_000, onRecoveryEvent() {} });
  const acquire = async (thread: Thread) => {
    if (!leases.has(thread)) { const lease = await runtime.acquireThread(thread); leases.set(thread, lease); lease.setRecoveryVisibility(true); }
  };
  let failure: unknown;
  try {
    await runtime.connect();
    const generation = runtime.getSnapshot().connectionGeneration;
    for (const event of events) {
      count(event.type);
      if (event.type === "acquire") await acquire(event.thread);
      else if (event.type === "release") { leases.get(event.thread)?.release(); leases.delete(event.thread); }
      else if (event.type === "retry") {
        const lease = leases.get(event.thread);
        if (lease) { const caller = { settled: false }; callers.push(caller); void lease.retryRestore().then(() => { caller.settled = true; }, () => { caller.settled = true; }); }
      } else if (event.type === "reply") replies.find(reply => reply.thread === event.thread && !reply.done)?.send();
      else if (event.type === "reconnect") { epoch++; await runtime.reconnect(); }
      for (let i = 0; i < 3; i++) await flush();
      requireThat(closes === 0 && initialized === 1 && runtime.getSnapshot().connectionGeneration === generation,
        "HYDRATION_HOST_ISOLATION", "logical recovery changed the healthy physical Host");
    }
    // Establish eligibility on both Threads, then recover from only new replies.
    healthy = true; await acquire("a"); await acquire("b"); epoch++; await runtime.reconnect();
    for (let i = 0; i < 40 && [...leases.values()].some(lease => !lease.getSnapshot().authoritative); i++) await flush();
    for (const [thread, lease] of leases) {
      requireThat(lease.getSnapshot().authoritative, "HYDRATION_HANDOFF", `${thread} still awaits a retired history operation`);
      requireThat(JSON.stringify(lease.getSnapshot()).includes(`${thread}-epoch-${epoch}`), "HYDRATION_CURRENT_BASELINE", `${thread} did not commit the current cut`);
    }
    requireThat(callers.every(caller => caller.settled), "HYDRATION_SETTLEMENT", "retired retry caller remains pending");
    for (const reply of replies) reply.send(); for (let i = 0; i < 10; i++) await flush();
    for (const [thread, lease] of leases) requireThat(lease.getSnapshot().authoritative && JSON.stringify(lease.getSnapshot()).includes(`${thread}-epoch-${epoch}`),
      "HYDRATION_LATE_RESULT", `${thread} late result overwrote the current baseline`);
    requireThat(closes === 0 && initialized === 1, "HYDRATION_HOST_ISOLATION", "recovery replaced the physical Host");
    return { events: events.length, historyRuns: replies.length, historyCompleted: replies.filter(reply => reply.done).length, coverage };
  } catch (error) { failure = error; throw error; }
  finally {
    ThreadResumeCoordinatorService.prototype.read = originalRead;
    for (const reply of replies) reply.send();
    for (const lease of leases.values()) lease.release();
    try { await runtime.dispose(); }
    catch (error) {
      if (failure instanceof ChaosViolation) failure.cleanupFailure = String(error);
      else if (!failure) throw error;
    }
  }
}
export function generateHydrationChaos(seed: number, steps = 80): HydrationChaosEvent[] {
  const random = recoveryChaosRandom(seed), events: HydrationChaosEvent[] = [{ type: "acquire", thread: "a" }];
  const types = ["acquire", "release", "retry", "reply", "reconnect", "flush"] as const;
  for (let i = 0; i < steps; i++) {
    const type = types[Math.floor(random() * types.length)]!;
    events.push(type === "reconnect" || type === "flush" ? { type } : { type, thread: random() < 0.5 ? "a" : "b" });
  }
  return events;
}
export function parseHydrationTrace(value: unknown): HydrationChaosEvent[] {
  requireThat(Array.isArray(value), "TRACE_SCHEMA", "hydration events must be an array");
  return value.map(event => {
    requireThat(event && typeof event === "object" && ["acquire", "release", "retry", "reply", "reconnect", "flush"].includes(event.type), "TRACE_SCHEMA", "unknown hydration event");
    if (event.type === "reconnect" || event.type === "flush") return { type: event.type };
    requireThat(event.thread === "a" || event.thread === "b", "TRACE_SCHEMA", "unknown Thread");
    return { type: event.type, thread: event.thread };
  });
}
