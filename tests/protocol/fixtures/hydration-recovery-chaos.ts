import { ResumeNotificationBufferService, ThreadResumeCoordinatorService } from "@opencraft/appserver-session";
import { SubmissionNotDispatchedError } from "@opencraft/chat-runtime";
import { createConversationKey } from "@opencraft/chat-core";
import type { SubmitIntent } from "@opencraft/composer-core";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
import { createAppServerWorkbenchRuntime, type AppServerThreadRuntimeLease } from "@opencraft/workbench-runtime";
import { ChaosViolation, requireThat, recoveryChaosRandom } from "./recovery-chaos";

type Thread = "a" | "b";
export type HydrationChaosEvent = { type: "acquire" | "release" | "retry" | "reply" | "submit" | "activation-reply"; thread: Thread }
  | { type: "snapshot-overlap"; thread: Thread; kind: "item-started" | "turn-started" | "status" }
  | { type: "dispatch-reconnect"; thread: Thread; stage: "queued" | "started" }
  | { type: "reconnect" | "flush" };
export interface HydrationChaosOptions { mutant?: "sticky-read" | "coupled-activation" | "early-dispatch" | "delta-only"; legacy?: boolean }
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** Real Workbench/Session/RPC/Replica and user command composition. History
 * becomes healthy before any held activation ACK; no live service is contacted. */
export async function simulateHydrationRecovery(events: readonly HydrationChaosEvent[], options: HydrationChaosOptions = {}) {
  const coverage: Record<string, number> = {}, count = (key: string) => { coverage[key] = (coverage[key] ?? 0) + 1; };
  const leases = new Map<Thread, AppServerThreadRuntimeLease>();
  const replies: { thread: Thread; epoch: number; kind: "history" | "activation"; done: boolean; send(overlap?: "item-started" | "turn-started" | "status"): void }[] = [];
  const overlappedCuts = new Map<Thread, number>();
  const callers: { settled: boolean }[] = [], arms = new Map<Thread, "queued" | "started">();
  type Intent = { thread: Thread; value: SubmitIntent; lease: AppServerThreadRuntimeLease; sends: number; settled: boolean; confirmed: boolean; error?: unknown };
  const intents = new Map<string, Intent>();
  let epoch = 0, healthy = false, activationsHealthy = false, initialized = 0, closes = 0, intentSequence = 0;
  let runtime!: ReturnType<typeof createAppServerWorkbenchRuntime>, wireViolation: unknown;
  const originalRead = ThreadResumeCoordinatorService.prototype.read, originalActivate = ThreadResumeCoordinatorService.prototype.activate;
  const originalOverlap = ResumeNotificationBufferService.prototype.hasSnapshotOverlap;
  if (options.mutant === "delta-only") ResumeNotificationBufferService.prototype.hasSnapshotOverlap = function (id) { return this.hasDeltas(id); };
  if (options.mutant === "sticky-read") {
    const sticky = new WeakMap<ThreadResumeCoordinatorService, Map<string, ReturnType<typeof originalRead>>>();
    ThreadResumeCoordinatorService.prototype.read = function (id, input = {}) {
      let slots = sticky.get(this); if (!slots) { slots = new Map(); sticky.set(this, slots); }
      if (!slots.has(id)) slots.set(id, originalRead.call(this, id, { ...input, signal: undefined }));
      return slots.get(id)!;
    };
  } else if (options.mutant === "coupled-activation") {
    ThreadResumeCoordinatorService.prototype.activate = function (input) { return this.resume(input).then(() => undefined); };
  }
  const checkWire = (condition: unknown, rule: string, detail: string) => {
    try { requireThat(condition, rule, detail); }
    catch (error) { wireViolation ??= error; throw error; }
  };
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
      const kind = request.method === "thread/resume" && !options.legacy ? "activation" : "history";
      const tag = `${thread}-epoch-${epoch}`, receivedEpoch = epoch;
      const turn = { id: `turn-${thread}`, status: "completed", itemsView: "full", items: [{ id: `item-${thread}`, type: "agentMessage", text: tag, phase: "final_answer" }], error: null };
      const reply = { thread, epoch: receivedEpoch, kind, done: false, send(overlap?: "item-started" | "turn-started" | "status") {
        if (this.done) return; this.done = true;
        if (this.epoch < epoch) count("retired-reply");
        if (overlap && this.epoch === epoch && kind === "history") {
          const notification = overlap === "item-started"
            ? { method: "item/started", params: { threadId: thread, turnId: turn.id, item: { ...turn.items[0], text: "" } } }
            : overlap === "turn-started" ? { method: "turn/started", params: { threadId: thread, turn: { ...turn, status: "inProgress", items: [] } } }
            : { method: "thread/status/changed", params: { threadId: thread, status: { type: "active", activeFlags: [] } } };
          peer.send(encodeJsonRpcMessage(notification)); overlappedCuts.set(thread, epoch); count(`snapshot-overlap-${overlap}`);
        }
        send({ thread: { id: thread, sessionId: thread, name: thread, path: `/rollouts/${thread}`, cwd: "/workspace", historyMode: options.legacy ? "message-window" : "paginated", model: "fixture", modelProvider: "fixture", turns: [], status: { type: "idle" } },
          model: "fixture", modelProvider: "fixture", cwd: "/workspace", runtimeWorkspaceRoots: [], approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: {},
          initialTurnsPage: { data: [turn], nextCursor: null }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
      } };
      replies.push(reply); count(kind === "history" ? "history-request" : "activation-request");
      if (kind === "history" && replies.some(other => other !== reply && other.thread === thread && !other.done && other.epoch < epoch)) {
        count("new-before-old-reply");
        if (replies.some(other => other.thread === thread && other.kind === "activation" && !other.done && other.epoch < epoch)) count("new-before-old-activation");
      }
      if (kind === "history" ? healthy : activationsHealthy) reply.send();
    } else if (request.method === "turn/start") {
      count("command-attempt");
      const params = request.params as { threadId: Thread; clientUserMessageId: string }, intent = intents.get(params.clientUserMessageId);
      checkWire(intent && intent.thread === params.threadId, "HYDRATION_USER_ADMISSION", "unknown or cross-Thread intent");
      checkWire(runtime.getSnapshot().phase === "ready" && runtime.getThreadResidency(params.threadId)?.authoritative
        && JSON.stringify(intent!.lease.getSnapshot()).includes(`${params.threadId}-epoch-${epoch}`),
        "COMMAND_ADMISSION", "a user write crossed a revoked or stale read baseline");
      checkWire(intent!.sends === 0, "HYDRATION_NO_REPLAY", "the same explicit user intent was sent twice");
      intent!.sends++; count("command-send"); send({ turn: { id: `turn-${params.clientUserMessageId}` } });
    } else if (request.method === "model/list") send({ data: [{ id: "fixture", model: "fixture", isDefault: true, inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null }], nextCursor: null });
    else if (request.method.endsWith("/list")) send({ data: [], nextCursor: null });
    else { checkWire(!["turn/steer", "thread/start"].includes(request.method), "HYDRATION_NO_REPLAY", request.method); send({}); }
  } });
  const close = transport.close.bind(transport); transport.close = async () => { closes++; await close(); };
  runtime = createAppServerWorkbenchRuntime({ hostId: "hydration-chaos", transport, autoReconnect: false, requestTimeoutMs: 60_000, onRecoveryEvent() {},
    installClientHandlers: client => {
      // queued observations intentionally contain no payload. Capture the
      // synchronous request scope rather than accessing redacted event params.
      let admittingThread: Thread | undefined;
      const request = client.request.bind(client);
      client.request = ((method, params, input) => {
        const previous = admittingThread, thread = (params as { threadId?: Thread })?.threadId;
        admittingThread = thread === "a" || thread === "b" ? thread : undefined;
        try { return request(method, params, options.mutant === "early-dispatch" && input ? { ...input, beforeSend: undefined } : input); }
        finally { admittingThread = previous; }
      }) as typeof client.request;
      return client.subscribeRequestLifecycle(event => {
        if (event.method !== "turn/start" || (event.type !== "queued" && event.type !== "started")) return;
        const thread = event.type === "started" ? (event.params as { threadId?: Thread }).threadId : admittingThread;
        if (thread && arms.get(thread) === event.type) {
          arms.delete(thread); count("dispatch-observer-reentry"); epoch++;
          void runtime.reconnect().catch(() => undefined);
        }
      });
    },
  });
  const acquire = async (thread: Thread) => {
    if (!leases.has(thread)) { const lease = await runtime.acquireThread(thread); leases.set(thread, lease); lease.setRecoveryVisibility(true); }
  };
  const launch = (record: Intent, lease: AppServerThreadRuntimeLease) => {
    record.lease = lease; record.settled = false; record.error = undefined;
    void lease.submit(record.value).then(receipt => {
      record.settled = true; record.confirmed = true;
      if (receipt.clientMessageId !== record.value.clientMessageId) wireViolation ??= new ChaosViolation("HYDRATION_USER_RECEIPT", "receipt changed intent identity");
    }, error => { record.settled = true; record.error = error; if (error instanceof SubmissionNotDispatchedError) count("known-unsent"); });
  };
  let failure: unknown;
  try {
    await runtime.connect(); const generation = runtime.getSnapshot().connectionGeneration;
    for (const event of events) {
      count(event.type);
      if (event.type === "acquire") await acquire(event.thread);
      else if (event.type === "release") { leases.get(event.thread)?.release(); leases.delete(event.thread); }
      else if (event.type === "retry") {
        const lease = leases.get(event.thread);
        if (lease) { const caller = { settled: false }; callers.push(caller); void lease.retryRestore().then(() => { caller.settled = true; }, () => { caller.settled = true; }); }
      } else if (event.type === "reply") replies.find(reply => reply.thread === event.thread && reply.kind === "history" && !reply.done)?.send();
      else if (event.type === "snapshot-overlap") replies.find(reply => reply.thread === event.thread && reply.kind === "history" && reply.epoch === epoch && !reply.done)?.send(event.kind);
      else if (event.type === "activation-reply") {
        // An explicit ACK event also gives asynchronous compiler/capability
        // preparation a bounded scheduling window before selecting the request.
        for (let i = 0; i < 40 && !replies.some(reply => reply.thread === event.thread && reply.kind === "activation" && !reply.done); i++) await flush();
        replies.find(reply => reply.thread === event.thread && reply.kind === "activation" && !reply.done)?.send();
        for (let i = 0; i < 40 && arms.has(event.thread); i++) await flush();
      }
      else if (event.type === "dispatch-reconnect") arms.set(event.thread, event.stage);
      else if (event.type === "submit") {
        const lease = leases.get(event.thread);
        if (lease) {
          const id = `intent-${++intentSequence}`;
          const record: Intent = { thread: event.thread, lease, sends: 0, settled: false, confirmed: false, value: {
            commandId: id, clientMessageId: id, target: { type: "existing-thread", key: createConversationKey("hydration-chaos", event.thread) },
            document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: id }] }] }, attachments: [], context: [], selections: {}, options: { autoContext: false }, createdAt: intentSequence,
          } };
          intents.set(id, record); launch(record, lease); count("user-intent");
        }
      } else if (event.type === "reconnect") {
        if (replies.some(reply => reply.kind === "activation" && !reply.done)) count("activation-overlap-reconnect");
        epoch++; await runtime.reconnect();
      }
      for (let i = 0; i < 3; i++) await flush();
      if (wireViolation) throw wireViolation;
      for (const [thread, cut] of overlappedCuts) if (cut === epoch && runtime.getThreadResidency(thread)?.authoritative) {
        const snapshot = leases.get(thread)?.getSnapshot();
        if (snapshot) {
          requireThat(JSON.stringify(snapshot.timeline).includes(`${thread}-epoch-${epoch}`)
            && snapshot.timeline.frames.filter(frame => frame.turnId === `turn-${thread}`).every(frame => frame.status === "complete")
            && (snapshot.threadStatus as { type?: string })?.type === "idle",
            "SNAPSHOT_CUT", `${thread} buffered lifecycle regressed the canonical snapshot`);
          overlappedCuts.delete(thread);
        }
      }
      requireThat(closes === 0 && initialized === 1 && runtime.getSnapshot().connectionGeneration === generation,
        "HYDRATION_HOST_ISOLATION", "logical recovery changed the healthy physical Host");
    }
    // Faults stop. Only current history is fair first; old activation may remain held.
    arms.clear(); healthy = true; await acquire("a"); await acquire("b"); epoch++; await runtime.reconnect();
    for (let i = 0; i < 60 && [...leases.values()].some(lease => !lease.getSnapshot().authoritative); i++) await flush();
    for (const [thread, lease] of leases) {
      requireThat(lease.getSnapshot().authoritative, "HYDRATION_HANDOFF", `${thread} still awaits a retired history or execution operation`);
      requireThat(JSON.stringify(lease.getSnapshot()).includes(`${thread}-epoch-${epoch}`), "HYDRATION_CURRENT_BASELINE", `${thread} did not commit the current cut`);
    }
    requireThat(callers.every(caller => caller.settled), "HYDRATION_SETTLEMENT", "retired retry caller remains pending");
    // Execution fairness is separate: ACKs now complete, and only proven-unsent
    // attempts may be retried with the original identity. Unknown writes never retry.
    activationsHealthy = true; for (const reply of replies) reply.send();
    for (let i = 0; i < 80 && [...intents.values()].some(intent => !intent.settled); i++) await flush();
    for (const record of intents.values()) if (record.error instanceof SubmissionNotDispatchedError) {
      requireThat(record.sends === 0, "HYDRATION_NO_REPLAY", "an unsent classification followed an actual send");
      launch(record, leases.get(record.thread)!); count("retry-known-unsent");
    }
    for (let i = 0; i < 80 && [...intents.values()].some(intent => !intent.settled); i++) await flush();
    if (wireViolation) throw wireViolation;
    for (const record of intents.values()) requireThat(record.settled && record.confirmed && record.sends === 1,
      "HYDRATION_USER_SETTLEMENT", `intent did not settle once: ${record.value.clientMessageId}, ${String(record.error)}`);
    for (const [thread, lease] of leases) requireThat(lease.getSnapshot().authoritative && JSON.stringify(lease.getSnapshot()).includes(`${thread}-epoch-${epoch}`),
      "HYDRATION_LATE_RESULT", `${thread} late result overwrote the current baseline`);
    requireThat(closes === 0 && initialized === 1, "HYDRATION_HOST_ISOLATION", "recovery replaced the physical Host");
    return { events: events.length, historyRuns: replies.filter(reply => reply.kind === "history").length,
      historyCompleted: replies.filter(reply => reply.kind === "history" && reply.done).length, coverage };
  } catch (error) { failure = error; throw error; }
  finally {
    ThreadResumeCoordinatorService.prototype.read = originalRead; ThreadResumeCoordinatorService.prototype.activate = originalActivate;
    ResumeNotificationBufferService.prototype.hasSnapshotOverlap = originalOverlap;
    for (const reply of replies) reply.send(); for (const lease of leases.values()) lease.release();
    try { await runtime.dispose(); }
    catch (error) { if (failure instanceof ChaosViolation) failure.cleanupFailure = String(error); else if (!failure) throw error; }
  }
}
export function generateHydrationChaos(seed: number, steps = 80): HydrationChaosEvent[] {
  const random = recoveryChaosRandom(seed), events: HydrationChaosEvent[] = [{ type: "acquire", thread: "a" }];
  const types = ["acquire", "release", "retry", "reply", "reconnect", "flush", "submit", "activation-reply", "dispatch-reconnect", "snapshot-overlap"] as const;
  for (let i = 0; i < steps; i++) {
    const type = types[Math.floor(random() * types.length)]!, thread = random() < 0.5 ? "a" : "b";
    events.push(type === "reconnect" || type === "flush" ? { type } : type === "dispatch-reconnect" ? { type, thread, stage: random() < 0.5 ? "queued" : "started" }
      : type === "snapshot-overlap" ? { type, thread, kind: (["item-started", "turn-started", "status"] as const)[Math.floor(random() * 3)]! } : { type, thread });
  }
  return events;
}
export function parseHydrationTrace(value: unknown): HydrationChaosEvent[] {
  requireThat(Array.isArray(value), "TRACE_SCHEMA", "hydration events must be an array");
  return value.map(event => {
    requireThat(event && typeof event === "object" && ["acquire", "release", "retry", "reply", "reconnect", "flush", "submit", "activation-reply", "dispatch-reconnect", "snapshot-overlap"].includes(event.type), "TRACE_SCHEMA", "unknown hydration event");
    if (event.type === "reconnect" || event.type === "flush") return { type: event.type };
    requireThat(event.thread === "a" || event.thread === "b", "TRACE_SCHEMA", "unknown Thread");
    if (event.type === "snapshot-overlap") { requireThat(["item-started", "turn-started", "status"].includes(event.kind), "TRACE_SCHEMA", "unknown snapshot notification"); return { type: event.type, thread: event.thread, kind: event.kind }; }
    if (event.type === "dispatch-reconnect") { requireThat(event.stage === "queued" || event.stage === "started", "TRACE_SCHEMA", "unknown dispatch stage"); return { type: event.type, thread: event.thread, stage: event.stage }; }
    return { type: event.type, thread: event.thread };
  });
}
