import { Service } from "@deepseek-ai/cordis";
import {
  startedTurnProjection,
  streamedAgentStartItem,
} from "./turn-lifecycle.ts";
import { stableDshSessionId } from "./dsh-native-session-store.ts";
import { addSpanEvent, endSpan, startSpan } from "../runtime/telemetry.ts";
import { modelProtocol, piAiCompatForRecord } from "./model-provider-protocol.ts";

const DSH_WORKER_STARTUP_TIMEOUT_MS = 60_000;
const DSH_TURN_DISPATCH_TIMEOUT_MS = 10_000;
const DSH_PREWARM_IDLE_TIMEOUT_MS = 10 * 60_000;

function monotonicNowMs() {
  return typeof globalThis.hostEvents?.monotonicNowMs === "function"
    ? globalThis.hostEvents.monotonicNowMs()
    : Date.now();
}

function itemStarted(record, item, startedAtMs = Date.now()) {
  return { threadId: record.threadId, turnId: record.turn.id, item, startedAtMs };
}

function itemCompleted(record, item, completedAtMs = Date.now()) {
  return { threadId: record.threadId, turnId: record.turn.id, item, completedAtMs };
}

function contentText(content) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("");
}

function contentReasoning(content) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === "reasoning")
    .map((block) => block.text)
    .join("");
}

function contentHasToolCall(content) {
  return (Array.isArray(content) ? content : [])
    .some((block) => block?.type === "tool-call");
}

function eventTime(event, fallback = Date.now()) {
  return Number.isFinite(event?.time) ? event.time : fallback;
}

function ensureReasoningStarted(service, active, startedAtMs = Date.now()) {
  if (active.reasoningItem) return active.reasoningItem;
  const manager = service.ctx.turnManager;
  const item = typeof manager.createReasoning === "function"
    ? manager.createReasoning(active.record)
    : manager.prepareReasoning(active.record);
  active.reasoningItem = item;
  active.reasoningText = "";
  service.notify("item/started", itemStarted(active.record, { ...item }, startedAtMs));
  return item;
}

function completeReasoning(service, active, completedAtMs = Date.now()) {
  const item = active.reasoningItem;
  if (!item) return;
  item.content = active.reasoningText ? [active.reasoningText] : [];
  service.notify("item/completed", itemCompleted(active.record, item, completedAtMs));
  active.reasoningItem = null;
  active.reasoningText = "";
}

function ensureAssistantStarted(service, worker, active, startedAtMs = Date.now()) {
  if (active.assistantStream) return active.assistantStream;
  const manager = service.ctx.turnManager;
  const item = typeof manager.createAgent === "function"
    ? manager.createAgent(active.record, null)
    : manager.prepareAgent(active.record);
  item.phase = null;
  const stream = {
    item,
    text: "",
    startedAtMs,
    messageCompletedAtMs: null,
  };
  active.assistantStream = stream;
  service.notify(
    "item/started",
    itemStarted(active.record, streamedAgentStartItem(item), startedAtMs),
  );
  return stream;
}

function streamAssistantDelta(service, worker, active, delta, startedAtMs = Date.now()) {
  if (!delta) return active.assistantStream;
  const stream = ensureAssistantStarted(service, worker, active, startedAtMs);
  stream.text += delta;
  service.ctx.textDeltaPacer.enqueue({
    threadId: worker.threadId,
    turnId: active.record.turn.id,
    itemId: stream.item.id,
  }, delta);
  return stream;
}

function reconcileAssistantMessage(
  service,
  worker,
  active,
  authoritativeText,
  atMs = Date.now(),
) {
  if (!authoritativeText && !active.assistantStream) return null;
  const stream = active.assistantStream
    ?? ensureAssistantStarted(service, worker, active, atMs);
  if (authoritativeText) {
    if (!stream.text) {
      streamAssistantDelta(service, worker, active, authoritativeText, atMs);
    } else if (authoritativeText.startsWith(stream.text)) {
      const suffix = authoritativeText.slice(stream.text.length);
      if (suffix) streamAssistantDelta(service, worker, active, suffix, atMs);
    } else if (authoritativeText !== stream.text) {
      // The completed item below is authoritative and will replace the live
      // reducer state. Avoid appending the full message again here: doing so
      // would duplicate already-streamed text in Desktop.
      console.warn(
        `[dsh-engine] assistant stream mismatch thread=${worker.threadId} ` +
        `streamed=${stream.text.length} authoritative=${authoritativeText.length}`,
      );
    }
    stream.text = authoritativeText;
  }
  stream.messageCompletedAtMs = atMs;
  return stream;
}

function prepareAssistantCompletion(active, phase = "commentary", completedAtMs = Date.now()) {
  const stream = active.assistantStream;
  if (!stream?.text) return null;
  const item = stream.item;
  item.text = stream.text;
  item.phase = phase;
  active.assistantStream = null;
  if (phase === "final_answer") {
    active.record.agentItem = item;
    active.finalItem = item;
    active.finalText = item.text;
  }
  return {
    item,
    completedAtMs: stream.messageCompletedAtMs ?? completedAtMs,
    metadata: {
      threadId: active.record.threadId,
      turnId: active.record.turn.id,
      itemId: item.id,
    },
  };
}

function projectRuntimeUserItem(service, worker, active, event) {
  const pending = active.pendingUserInputs?.shift();
  if (!pending) return;
  // turn/start already projected its user item before dispatch.  DSH echoes
  // that same input when it begins consuming the Turn, so only use the first
  // runtime event as an acknowledgement.  Steered inputs are different: the
  // DSH user/message boundary is authoritative because it occurs after any
  // preceding assistant response has closed and before the next step starts.
  if (pending.projected) return;
  const manager = service.ctx.turnManager;
  const item = manager.createUser(active.record, pending.input, pending.clientId);
  const at = eventTime(event);
  service.notify("item/started", itemStarted(active.record, { ...item }, at));
  service.notify("item/completed", itemCompleted(active.record, item, at));
}

export class DshEngineAdapterService extends Service {
  constructor(ctx) {
    super(ctx, "dshEngineAdapter");
    this.workers = new Map();
    this.sequence = 0;
    ctx.effect(() => ctx.appServer.intercept((message) => {
      if (message == null) this.poll();
      return false;
    }));
    ctx.effect(() => () => {
      for (const worker of this.workers.values()) this.stopWorker(worker);
      this.workers.clear();
    });
  }

  supports(profile) {
    return profile?.engineKind === "dsh";
  }

  hasThread(threadId) {
    return this.workers.has(threadId);
  }

  retireThread(threadId) {
    const worker = this.workers.get(threadId);
    if (!worker || worker.active) return false;
    this.stopWorker(worker);
    this.workers.delete(threadId);
    return true;
  }

  runtimeRoute(username, providerId) {
    return hostModelGateway.runtimeRoute(username, providerId);
  }

  prepareThread({
    threadId, profile, credential, connection = null, filesystem, viewId = "main", cwd,
    prewarm = false,
  }) {
    if (!this.supports(profile)) throw new Error("DSH adapter received a non-DSH execution profile");
    if (!credential?.userId) throw new Error("DSH execution requires an authenticated user credential");
    const capabilityBindings = this.ctx.agentCapabilityEgress?.bindingsForThread?.(
      threadId,
      connection,
    ) ?? [];
    const capabilityFingerprint = capabilityBindings
      .map((binding) => `${binding.capabilityId}:${binding.tool?.name ?? ""}`)
      .sort()
      .join("|");
    let worker = this.workers.get(threadId);
    if (worker?.profileFingerprint === profile.fingerprint &&
        worker.capabilityFingerprint === capabilityFingerprint) return worker;
    if (worker) {
      this.stopWorker(worker);
      this.workers.delete(threadId);
      worker = null;
    }
    const providerId = profile.providerId;
    const user = this.ctx.userDirectory.find(credential.userId);
    if (!user?.username) throw new Error("DSH execution requires a materialized SSH user");
    const route = this.runtimeRoute(user.username, providerId);
    const providerRecord = this.ctx.modelGateway.resolveGatewayRoute(providerId) ?? { model: route.model };
    const providerInputModalities = this.ctx.modelMetadata.inputModalitiesForRecord(providerRecord);
    const thread = this.ctx.threadManager.get(threadId);
    const currentSessionId = typeof this.ctx.dshNativeSessionStore.currentSessionId === "function"
      ? this.ctx.dshNativeSessionStore.currentSessionId(threadId)
      : (this.ctx.dshNativeSessionStore.has(threadId) ? stableDshSessionId(threadId) : null);
    const nativeHistory = typeof this.ctx.threadExecution?.nativeHistory === "function"
      ? this.ctx.threadExecution.nativeHistory(threadId)
      : { available: false, attempts: 0, nativeStarts: 0 };
    // AppServer turns are a presentation projection, not proof that a DSH
    // ledger ever became authoritative. A failed admission/dispatch may have
    // created an outer Turn without reaching native turn/start. Only durable
    // execution evidence may safely distinguish that case from a lost ledger.
    const onlyFailedBeforeNativeStart = nativeHistory.available === true &&
      nativeHistory.attempts > 0 && nativeHistory.nativeStarts === 0;
    const projectedTurns = this.ctx.canonicalTimeline.turns(threadId);
    const emptyLedgerMayBootstrap = projectedTurns.length === 0 || onlyFailedBeforeNativeStart;
    // A stale pointer created by the old prewarm bug must not force recovery
    // from an empty SQLite file. Passing false only relaxes the missing-ledger
    // assertion: if a real persisted session exists, the worker still resumes
    // it through its ordinary stored-session branch.
    const expectExistingSession = currentSessionId != null && !emptyLedgerMayBootstrap;
    if (currentSessionId == null && projectedTurns.length > 0 &&
        !onlyFailedBeforeNativeStart) {
      throw new Error(
        `DSH native ledger is missing for ${threadId}; run an explicit engine migration before execution`,
      );
    }

    worker = this.createWorker({
      threadId, profile, route, user, filesystem, viewId, cwd: cwd ?? thread.cwd,
      expectExistingSession, providerRecord, providerInputModalities,
      currentSessionId: currentSessionId ?? stableDshSessionId(threadId), prewarm,
      connection, capabilityBindings, capabilityFingerprint,
    });
    this.workers.set(threadId, worker);
    return worker;
  }

  startTurn({
    connection, threadId, message, profile, credential, filesystem, viewId = "main", cwd,
    suppressResponse = false,
  }) {
    const thread = this.ctx.threadManager.get(threadId);
    const worker = this.prepareThread({
      threadId, profile, credential, connection, filesystem, viewId, cwd: cwd ?? thread.cwd,
    });
    const providerId = worker.providerId || profile.providerId;
    const model = worker.model || profile.model;
    const record = this.ctx.turnManager.start(
      threadId,
      Array.isArray(message.params?.input) ? message.params.input : [],
      message.params?.clientUserMessageId ?? null,
    );
    const execution = this.ctx.threadExecution.bindTurn(
      threadId, connection, record.turn.id,
    );
    if (!execution) {
      this.ctx.threadExecution.abortRequest(threadId, connection, message.id);
      throw new Error("DSH Turn authority changed before dispatch");
    }

    if (worker.active) {
      this.ctx.threadExecution.abortRequest(threadId, connection, message.id);
      throw new Error("DSH worker already has an active Turn");
    }

    worker.active = {
      connection,
      requestId: message.id,
      record,
      completed: false,
      reasoningItem: null,
      reasoningText: "",
      assistantStream: null,
      pendingUserInputs: [{
        input: message.params?.input ?? [],
        clientId: message.params?.clientUserMessageId ?? null,
        projected: true,
      }],
      eventBarrier: false,
      deferredMessages: [],
      pendingAssistantCompletion: null,
      terminalOverride: null,
      finalItem: null,
      finalText: "",
      executionEpoch: execution.epoch,
      nativeStarted: false,
      nativeTurnId: null,
      turnDispatched: false,
      startupDeadlineMs: worker.initialized
        ? null
        : Date.now() + DSH_WORKER_STARTUP_TIMEOUT_MS,
      dispatchDeadlineMs: null,
      telemetry: {
        span: startSpan("hypernode.dsh.turn", {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.provider.name": providerId,
          "gen_ai.request.model": model,
          "hypernode.engine.kind": "dsh",
          "hypernode.thread_id": threadId,
          "hypernode.turn_id": record.turn.id,
        }),
        eventCount: 0,
        reasoningDeltaCount: 0,
        textDeltaCount: 0,
        lastEventAt: null,
        finished: false,
      },
    };
    addSpanEvent(worker.active.telemetry.span, "dsh.worker.acquired", {
      "hypernode.dsh.worker_initialized": worker.initialized,
      "hypernode.dsh.worker_prewarmed": worker.prewarmed === true,
      "hypernode.dsh.worker_startup_ms": worker.startupDurationMs ?? -1,
    });
    worker.used = true;
    worker.prewarmed = false;
    worker.prewarmExpiresAtMs = null;
    this.ctx.dshAppServerProjection?.begin(worker.active, {
      cwd: worker.cwd ?? cwd ?? thread.cwd,
    });
    this.ctx.threadExecution.bindRuntime(
      threadId, connection, worker.processId, threadId,
      execution.epoch, profile.fingerprint,
    );
    this.notify("thread/status/changed", {
      threadId, status: { type: "active", activeFlags: [] },
    });
    this.notify("turn/started", {
      threadId, turn: startedTurnProjection(record.turn),
    });
    this.notify("item/started", itemStarted(record, record.userItem, record.startedAtMs));
    this.notify("item/completed", itemCompleted(record, record.userItem));
    if (!suppressResponse) {
      this.ctx.appServer.send(connection, {
        id: message.id,
        result: { turn: startedTurnProjection(record.turn) },
      });
    }
    this.dispatchActiveTurn(worker);
    return record;
  }

  dispatchActiveTurn(worker) {
    const active = worker?.active;
    if (!active || active.completed || active.turnDispatched || !worker.initialized) return false;
    active.turnDispatched = true;
    active.startupDeadlineMs = null;
    active.dispatchDeadlineMs = Date.now() + DSH_TURN_DISPATCH_TIMEOUT_MS;
    try {
      this.ctx.dshRuntimeHost.send(worker.processId, {
        type: "turn/start",
        requestId: String(active.requestId),
        turnId: active.record.turn.id,
        input: active.pendingUserInputs?.[0]?.input ?? [],
      });
    } catch (error) {
      active.turnDispatched = false;
      active.dispatchDeadlineMs = null;
      this.failWorker(worker, error?.message ?? String(error));
      return false;
    }
    return true;
  }

  steer({ connection, threadId, message }) {
    const worker = this.workers.get(threadId);
    if (!worker?.active) throw new Error("No active DSH Turn is available for steering");
    const pending = {
      input: message.params?.input ?? [],
      clientId: message.params?.clientUserMessageId ?? null,
      projected: false,
    };
    (worker.active.pendingUserInputs ??= []).push(pending);
    try {
      this.ctx.dshRuntimeHost.send(worker.processId, {
        type: "turn/steer",
        requestId: String(message.id),
        input: pending.input,
      });
    } catch (error) {
      const index = worker.active.pendingUserInputs.indexOf(pending);
      if (index >= 0) worker.active.pendingUserInputs.splice(index, 1);
      throw error;
    }
    this.ctx.appServer.send(connection, {
      id: message.id,
      result: { turnId: worker.active.record.turn.id },
    });
  }

  interrupt({ connection, threadId, message }) {
    const worker = this.workers.get(threadId);
    if (!worker?.active) {
      const interrupted = this.ctx.threadManager.reconcileInterruptedRuntime(threadId);
      for (const turn of interrupted) {
        this.notify("turn/completed", {
          threadId,
          turn: { ...turn, itemsView: "summary" },
        });
      }
      this.notify("thread/status/changed", { threadId, status: { type: "idle" } });
      this.ctx.threadExecution.complete(threadId, { reason: "dshInterruptConverged" });
      this.ctx.appServer.send(connection, { id: message.id, result: {} });
      if (worker) {
        this.stopWorker(worker);
        this.workers.delete(threadId);
      }
      return;
    }
    const active = worker.active;
    try {
      this.ctx.dshRuntimeHost.send(worker.processId, {
        type: "turn/interrupt",
        requestId: String(message.id),
      });
    } catch {}
    this.interruptWorkerTurn(worker, "dshTurnInterrupted");
    this.ctx.appServer.send(connection, { id: message.id, result: {} });
    this.stopWorker(worker);
    this.workers.delete(threadId);
  }

  interruptWorkerTurn(worker, reason = "dshTurnInterrupted") {
    const active = worker.active;
    if (!active || active.completed) return;
    active.completed = true;
    completeReasoning(this, active);
    if (active.pendingAssistantCompletion) {
      active.terminalOverride = () => this.finishInterruptedWorkerTurn(worker, active, reason);
      this.ctx.textDeltaPacer.flush(active.pendingAssistantCompletion.metadata);
      return;
    }
    this.completeAssistantThen(
      worker,
      active,
      "final_answer",
      Date.now(),
      () => this.finishInterruptedWorkerTurn(worker, active, reason),
      { flush: true },
    );
  }

  finishInterruptedWorkerTurn(worker, active, reason) {
    if (worker.active !== active) return;
    this.ctx.dshAppServerProjection?.settle(worker, active);
    this.finishDshTelemetry(active, "cancelled");
    const interrupted = this.ctx.turnManager.interrupt(active.record);
    this.notify("turn/completed", {
      threadId: worker.threadId,
      turn: { ...interrupted.turn, itemsView: "summary" },
    });
    this.notify("thread/status/changed", {
      threadId: worker.threadId, status: { type: "idle" },
    });
    this.ctx.threadExecution.abortRequest(
      worker.threadId, active.connection, active.requestId, reason,
    );
    active.connection.threadWriteLease?.release(worker.threadId, active.connection);
    worker.active = null;
    worker.lifecycle = "ready";
  }

  createWorker({
    threadId, profile, route, user, filesystem, viewId, cwd,
    expectExistingSession = false, providerRecord,
    providerInputModalities = ["text"], currentSessionId, prewarm = false,
    connection = null, capabilityBindings = null, capabilityFingerprint = null,
  }) {
    const model = route.model || profile.model;
    const startupStartedAtMs = monotonicNowMs();
    const startupSpan = startSpan("hypernode.dsh.worker.initialize", {
      "gen_ai.provider.name": route.providerId,
      "gen_ai.request.model": model,
      "hypernode.engine.kind": "dsh",
      "hypernode.thread_id": threadId,
      "hypernode.dsh.prewarm": prewarm,
    });
    const processId = `dsh-engine-${++this.sequence}`;
    capabilityBindings ??= this.ctx.agentCapabilityEgress?.bindingsForThread?.(
      threadId,
      connection,
    ) ?? [];
    capabilityFingerprint ??= capabilityBindings
      .map((binding) => `${binding.capabilityId}:${binding.tool?.name ?? ""}`)
      .sort()
      .join("|");
    const workspacePathMappings = [];
    const publicCodexHome = "/workspace/.codex";
    if (filesystem?.owns?.(publicCodexHome) && typeof filesystem?.toPhysical === "function") {
      const privateCodexHome = filesystem.toPhysical(publicCodexHome, user, viewId);
      if (privateCodexHome && privateCodexHome !== publicCodexHome) {
        workspacePathMappings.push({ publicPath: publicCodexHome, privatePath: privateCodexHome });
      }
    }
    let attachment;
    try {
      attachment = this.ctx.workspaceAttachment.attach({
        threadId,
        engineId: processId,
        viewId,
        cwd,
        filesystem,
        principal: user,
      });
      this.ctx.dshRuntimeHost.start(processId, user, route.providerId);
    } catch (error) {
      endSpan(startupSpan, "error");
      attachment?.detach("runtimeStartFailed");
      throw error;
    }
    const worker = {
      threadId,
      processId,
      attachment,
      profileFingerprint: profile.fingerprint,
      capabilityFingerprint,
      active: null,
      stderr: [],
      initialized: false,
      lifecycle: "starting",
      cwd,
      providerId: route.providerId,
      model,
      prewarmed: prewarm,
      used: false,
      prewarmExpiresAtMs: prewarm ? Date.now() + DSH_PREWARM_IDLE_TIMEOUT_MS : null,
      startupStartedAtMs,
      startupDurationMs: null,
      startupSpan,
    };
    try {
      this.ctx.dshRuntimeHost.send(processId, {
        type: "initialize",
        requestId: `initialize-${this.sequence}`,
        provider: route.providerId,
        model,
        displayName: route.displayName || profile.model,
        baseURL: route.gatewayBaseURL ?? route.responsesBaseURL,
        apiProtocol: modelProtocol(providerRecord),
        compat: piAiCompatForRecord(providerRecord),
        inputModalities: providerInputModalities,
        logicalSessionId: stableDshSessionId(threadId),
        sessionId: currentSessionId ?? stableDshSessionId(threadId),
        cwd,
        expectExistingSession,
        workspace: attachment.endpoint ? {
          transport: "ssh",
          host: attachment.endpoint.host,
          port: attachment.endpoint.port,
          username: "root",
          pathMappings: workspacePathMappings,
        } : null,
        capabilities: capabilityBindings,
      });
    } catch (error) {
      endSpan(startupSpan, "error");
      try { this.ctx.dshRuntimeHost.stop(processId, 2_000); } catch {}
      attachment.detach("runtimeInitializeFailed");
      throw error;
    }
    return worker;
  }

  poll() {
    for (const worker of this.workers.values()) this.pollWorker(worker);
  }

  pollWorker(worker) {
    if (!worker.active && worker.prewarmed && !worker.used &&
        worker.prewarmExpiresAtMs != null && Date.now() >= worker.prewarmExpiresAtMs) {
      this.stopWorker(worker);
      if (this.workers.get(worker.threadId) === worker) this.workers.delete(worker.threadId);
      return;
    }
    let drained;
    try {
      drained = this.ctx.dshRuntimeHost.drain(worker.processId);
    } catch (error) {
      this.failWorker(worker, error?.message ?? String(error));
      return;
    }
    if (drained.stderrLines?.length) worker.stderr.push(...drained.stderrLines.slice(-32));
    for (const line of drained.stdoutLines ?? []) {
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      this.onWorkerMessage(worker, message);
    }
    if (worker.active && !worker.initialized && worker.active.startupDeadlineMs != null &&
        Date.now() >= worker.active.startupDeadlineMs) {
      this.failWorker(worker, "DSH worker did not become ready within 60 seconds");
      return;
    }
    if (worker.active && worker.active.turnDispatched && !worker.active.nativeStarted &&
        worker.active.dispatchDeadlineMs != null &&
        Date.now() >= worker.active.dispatchDeadlineMs) {
      this.failWorker(worker, "DSH did not publish turn/start within 10 seconds of dispatch");
      return;
    }
    if (drained.exited) {
      const reason = drained.error || `DSH worker exited with ${drained.exitCode}`;
      this.failWorker(worker, reason);
    }
  }

  rememberNativeSession(worker, snapshot) {
    if (!snapshot) return;
    try {
      this.ctx?.dshNativeSessionStore?.remember(
        worker.threadId,
        snapshot,
        snapshot.provenance ?? "native",
      );
    } catch (error) {
      // The worker-owned official DSH SQLite ledger is the execution
      // authority. This registry only remembers its current descriptor,
      // so descriptor persistence failure must never kill a Turn.
      console.warn(
        `[dsh-engine] native session descriptor persistence failed thread=${worker.threadId}: ` +
        `${error?.message ?? error}`,
      );
    }
  }

  onWorkerMessage(worker, message) {
    if (message.type === "capability-request") {
      const requestId = String(message.requestId ?? "");
      if (!requestId) return;
      const principalId = worker.active?.connection?.identity?.id ?? null;
      try {
        if (!worker.active) throw new Error("Agent capability call has no active Turn");
        const result = this.ctx.agentCapabilityEgress.execute({
          capabilityId: String(message.capabilityId ?? ""),
          threadId: worker.threadId,
          turnId: worker.active.record.turn.id,
          callId: requestId,
          principalId,
          connection: worker.active.connection,
          arguments: message.arguments && typeof message.arguments === "object"
            ? message.arguments
            : {},
        });
        Promise.resolve(result).then((resolved) => {
          this.ctx.dshRuntimeHost.send(worker.processId, {
            type: "capability-response",
            requestId,
            result: resolved,
          });
        }, (error) => {
          this.ctx.dshRuntimeHost.send(worker.processId, {
            type: "capability-response",
            requestId,
            error: error?.message ?? String(error),
          });
        });
      } catch (error) {
        this.ctx.dshRuntimeHost.send(worker.processId, {
          type: "capability-response",
          requestId,
          error: error?.message ?? String(error),
        });
      }
      return;
    }
    if (message.type === "capability-cancel") {
      const requestId = String(message.requestId ?? "");
      if (requestId) {
        this.ctx.agentCapabilityEgress.cancel(
          worker.threadId,
          requestId,
          "DSH cancelled the browser capability call",
        );
      }
      return;
    }
    if (message.type === "initialized") {
      worker.nativeSessionSnapshot = message.snapshot ?? null;
      // A new empty Session is not durable merely because createAgent()
      // returned a header.  Register it only after the worker flushes its
      // first native turn/start. Existing/resumed ledgers are already
      // materialized and remain eligible for immediate recovery.
      if (message.snapshot?.materialized === true) {
        this.rememberNativeSession(worker, message.snapshot);
      }
      worker.initialized = true;
      worker.lifecycle = "ready";
      worker.startupDurationMs = Math.max(0, monotonicNowMs() - worker.startupStartedAtMs);
      addSpanEvent(worker.startupSpan, "dsh.worker.ready", {
        "hypernode.dsh.worker_startup_ms": worker.startupDurationMs,
      });
      endSpan(worker.startupSpan, "ok");
      this.dispatchActiveTurn(worker);
      return;
    }
    if (message.type === "session-materialized") {
      const snapshot = message.snapshot ?? worker.nativeSessionSnapshot;
      worker.nativeSessionSnapshot = snapshot ?? null;
      this.rememberNativeSession(worker, snapshot);
      return;
    }
    if (message.type === "error") {
      this.failWorker(worker, message.message ?? "DSH worker failed");
      return;
    }
    if (message.type === "turn-rejected") {
      if (worker.active && (!message.clientTurnId ||
          message.clientTurnId === worker.active.record.turn.id)) {
        this.failWorker(worker, message.message ?? "DSH rejected the dispatched Turn");
      }
      return;
    }
    if (message.type !== "session-event") return;
    // Do not mirror live chunks into HyperNode's policy database.  The DSH
    // persistence plugin has already committed them to its native ledger;
    // duplicating them here made every append reload and parse the full log.
    if (!worker.active) return;
    const active = worker.active;
    if (message.clientTurnId && message.clientTurnId !== active.record.turn.id) return;
    if (message.event?.type === "turn/start" && !active.nativeStarted) {
      const nativeTurnId = String(message.event.data?.turn ?? message.event.seq ?? "");
      const markNativeStarted = this.ctx.threadExecution.markNativeStarted;
      if (typeof markNativeStarted === "function") {
        const execution = markNativeStarted.call(
          this.ctx.threadExecution,
          worker.threadId,
          active.connection,
          nativeTurnId,
          active.executionEpoch,
        );
        if (!execution) {
          this.failWorker(worker, "DSH native turn/start arrived after execution authority changed");
          return;
        }
      }
      active.nativeStarted = true;
      active.nativeTurnId = nativeTurnId;
      active.dispatchDeadlineMs = null;
      worker.lifecycle = "running";
      addSpanEvent(active.telemetry?.span, "dsh.turn.native_started", {
        "hypernode.dsh.native_turn_id": nativeTurnId,
      });
    }
    this.recordSessionEvent(active, message);
    if (active.eventBarrier) {
      active.deferredMessages.push(message);
      return;
    }
    this.processSessionEvent(worker, active, message);
  }

  completeAssistantThen(
    worker,
    active,
    phase,
    completedAtMs,
    continuation = () => {},
    { flush = false } = {},
  ) {
    const completion = prepareAssistantCompletion(active, phase, completedAtMs);
    if (!completion) {
      continuation();
      return false;
    }
    active.eventBarrier = true;
    active.pendingAssistantCompletion = completion;
    this.ctx.textDeltaPacer.afterDrained(completion.metadata, () => {
      if (worker.active !== active) return;
      this.notify("item/completed", itemCompleted(
        active.record,
        completion.item,
        completion.completedAtMs,
      ));
      active.pendingAssistantCompletion = null;
      const terminalOverride = active.terminalOverride;
      active.terminalOverride = null;
      if (terminalOverride) terminalOverride();
      else continuation();
      this.releaseEventBarrier(worker, active);
    });
    if (flush) this.ctx.textDeltaPacer.flush(completion.metadata);
    return true;
  }

  releaseEventBarrier(worker, active) {
    if (worker.active !== active) return;
    active.eventBarrier = false;
    while (!active.eventBarrier && worker.active === active && active.deferredMessages.length > 0) {
      const message = active.deferredMessages.shift();
      this.processSessionEvent(worker, active, message);
    }
  }

  processSessionEvent(worker, active, message) {
    const event = message.event;
    if (event?.type === "user/message") {
      completeReasoning(this, active, eventTime(event));
      this.completeAssistantThen(
        worker,
        active,
        "commentary",
        eventTime(event),
        () => projectRuntimeUserItem(this, worker, active, event),
      );
      return;
    }
    if (event?.type === "step/start") {
      // A new step proves that a preceding assistant message was not terminal.
      // Preserve it as commentary before opening the next unit of work.
      completeReasoning(this, active, eventTime(event));
      this.completeAssistantThen(worker, active, "commentary", eventTime(event));
      // A DSH step is one model call plus any tools it requests. It is not
      // evidence that the model emitted reasoning. Keep the step boundary in
      // the engine lifecycle and create a Desktop reasoning item only after a
      // real reasoning-delta (or an authoritative reasoning content block).
      return;
    }
    if (event?.type === "tool/call") {
      completeReasoning(this, active, eventTime(event));
      // Defensive fallback for providers that emit the call after a no-tool
      // assistant envelope. A following tool means that text was commentary.
      if (active.assistantStream) {
        this.completeAssistantThen(
          worker,
          active,
          "commentary",
          eventTime(event),
          () => this.ctx.dshAppServerProjection?.handle(worker, active, event),
        );
        return;
      }
    }
    if (this.ctx?.dshAppServerProjection?.handle(worker, active, event)) return;
    if (event?.type === "assistant/chunk" && event.data?.chunk?.type === "reasoning-delta") {
      const delta = event.data.chunk.text ?? "";
      if (!delta) return;
      const item = ensureReasoningStarted(this, active, eventTime(event));
      active.reasoningText += delta;
      this.notify("item/reasoning/textDelta", {
        threadId: worker.threadId,
        turnId: active.record.turn.id,
        itemId: item.id,
        contentIndex: 0,
        delta,
      });
      return;
    }
    if (event?.type === "assistant/chunk" && event.data?.chunk?.type === "text-delta") {
      const delta = event.data.chunk.text ?? "";
      streamAssistantDelta(this, worker, active, delta, eventTime(event));
      return;
    }
    if (event?.type === "assistant/message") {
      const content = event.data?.message?.content;
      const authoritativeReasoning = contentReasoning(content);
      if (authoritativeReasoning && !active.reasoningText) {
        const reasoning = ensureReasoningStarted(this, active, eventTime(event));
        active.reasoningText = authoritativeReasoning;
        this.notify("item/reasoning/textDelta", {
          threadId: worker.threadId,
          turnId: active.record.turn.id,
          itemId: reasoning.id,
          contentIndex: 0,
          delta: authoritativeReasoning,
        });
      }
      completeReasoning(this, active, eventTime(event));
      const authoritative = contentText(content);
      reconcileAssistantMessage(this, worker, active, authoritative, eventTime(event));
      if (contentHasToolCall(content)) {
        this.completeAssistantThen(worker, active, "commentary", eventTime(event));
      }
      // Do not call text final merely because the provider stopped emitting
      // chunks. DSH's turn/end(completed) is the commit record; until then the
      // started item intentionally retains phase=null.
      return;
    }
    if (event?.type === "step/end") {
      completeReasoning(this, active, eventTime(event));
      return;
    }
    if (event?.type === "turn/end") {
      // Terminal convergence must close every visible item before the Turn.
      // Normally assistant/message or step/end already did this, but keeping
      // the boundary idempotent prevents a truncated provider stream from
      // leaving Desktop with a completed Turn containing an active spinner.
      completeReasoning(this, active, eventTime(event));
      const reason = event.data?.reason;
      if (reason?.kind === "error") {
        const failure = reason.error ?? reason.failure;
        this.failWorker(
          worker,
          failure?.message ?? `DSH Turn failed (${failure?.code ?? "unknown"})`,
        );
        return;
      }
      if (reason?.kind === "aborted" || reason?.kind === "interrupted") {
        this.interruptWorkerTurn(worker, `dshTurn${reason.kind}`);
        return;
      }
      if (reason?.kind === "blocked" || reason?.kind === "max-tokens") {
        this.failWorker(worker, reason.kind === "blocked"
          ? "DSH Turn was blocked before completion"
          : "DSH Turn reached the model output-token limit");
        return;
      }
      if (reason?.kind !== "completed") {
        this.failWorker(worker, `DSH Turn ended with unsupported reason: ${reason?.kind ?? "unknown"}`);
        return;
      }
      this.completeAssistantThen(worker, active, "final_answer", eventTime(event), () => {
        if (!active.finalText) {
          this.failWorker(worker, "DSH Turn completed without an assistant message");
          return;
        }
        this.ctx.dshAppServerProjection?.settle(worker, active);
        this.completeWorkerTurn(worker);
      });
    }
  }

  recordSessionEvent(active, message) {
    const telemetry = active.telemetry;
    if (!telemetry || telemetry.finished) return;
    const event = message.event;
    const type = String(event?.type ?? "unknown");
    const now = typeof globalThis.hostEvents?.monotonicNowMs === "function"
      ? globalThis.hostEvents.monotonicNowMs()
      : Date.now();
    const previous = telemetry.lastEventAt;
    telemetry.lastEventAt = now;
    telemetry.eventCount += 1;
    const chunkType = event?.data?.chunk?.type;
    if (type === "assistant/chunk" && chunkType === "reasoning-delta") {
      telemetry.reasoningDeltaCount += 1;
    } else if (type === "assistant/chunk" && chunkType === "text-delta") {
      telemetry.textDeltaCount += 1;
    }
    if (telemetry.eventCount === 1) {
      addSpanEvent(telemetry.span, "dsh.ledger.first", {
        "hypernode.dsh.event_type": type,
      });
    } else if (previous != null && now - previous >= 1_000) {
      addSpanEvent(telemetry.span, "dsh.ledger.gap", {
        "hypernode.dsh.event_type": type,
        "hypernode.dsh.gap_ms": now - previous,
        "hypernode.dsh.event_count": telemetry.eventCount,
      });
    }
    if (["step/start", "step/end", "tool/call", "assistant/message", "turn/end"].includes(type)) {
      addSpanEvent(telemetry.span, "dsh.ledger.boundary", {
        "hypernode.dsh.event_type": type,
        "hypernode.dsh.event_count": telemetry.eventCount,
      });
    }
  }

  finishDshTelemetry(active, status) {
    const telemetry = active?.telemetry;
    if (!telemetry || telemetry.finished) return;
    telemetry.finished = true;
    addSpanEvent(telemetry.span, "dsh.ledger.terminal", {
      "hypernode.dsh.event_count": telemetry.eventCount,
      "hypernode.dsh.reasoning_delta_count": telemetry.reasoningDeltaCount,
      "hypernode.dsh.text_delta_count": telemetry.textDeltaCount,
    });
    endSpan(telemetry.span, status);
  }

  completeWorkerTurn(worker) {
    const active = worker.active;
    if (!active || active.completed) return;
    active.completed = true;
    this.finishDshTelemetry(active, "ok");
    const completed = this.ctx.turnManager.complete(active.record);
    this.notify("turn/completed", {
      threadId: worker.threadId,
      turn: { ...completed.turn, itemsView: "summary" },
    });
    this.notify("thread/status/changed", {
      threadId: worker.threadId, status: { type: "idle" },
    });
    this.ctx.threadExecution.complete(worker.threadId, {
      connection: active.connection,
      requestId: active.requestId,
      turnId: active.record.turn.id,
      reason: "dshTurnCompleted",
    });
    active.connection.threadWriteLease?.release(worker.threadId, active.connection);
    worker.active = null;
    worker.lifecycle = "ready";
  }

  failWorker(worker, reason) {
    if (!this.workers.has(worker.threadId)) return;
    worker.lifecycle = "failed";
    const detail = worker.stderr.length
      ? `${reason}: ${worker.stderr.slice(-3).join(" | ")}`
      : reason;
    const active = worker.active;
    if (active && !active.completed) {
      active.completed = true;
      completeReasoning(this, active);
      if (active.pendingAssistantCompletion) {
        active.terminalOverride = () => this.finishFailedWorker(worker, active, detail);
        this.ctx.textDeltaPacer.flush(active.pendingAssistantCompletion.metadata);
        return;
      }
      this.completeAssistantThen(
        worker,
        active,
        "commentary",
        Date.now(),
        () => this.finishFailedWorker(worker, active, detail),
        { flush: true },
      );
      return;
    }
    this.finishStoppedWorker(worker, detail);
  }

  finishFailedWorker(worker, active, detail) {
    if (worker.active !== active) return;
    this.ctx.dshAppServerProjection?.settle(worker, active);
    this.finishDshTelemetry(active, "error");
    const completedAt = Math.floor(Date.now() / 1_000);
    this.ctx.turnManager.fail(active.record, detail, completedAt);
    // Match the native app-server failure contract. Desktop renders the
    // user-facing failure from this typed notification; a failed
    // `turn/completed` alone only settles its lifecycle state.
    this.notify("error", {
      error: {
        message: detail,
        codexErrorInfo: null,
        additionalDetails: null,
      },
      willRetry: false,
      threadId: worker.threadId,
      turnId: active.record.turn.id,
    });
    this.notify("turn/completed", {
      threadId: worker.threadId,
      turn: { ...active.record.turn, itemsView: "summary" },
    });
    this.notify("thread/status/changed", {
      threadId: worker.threadId, status: { type: "idle" },
    });
    this.ctx.threadExecution.abortRequest(
      worker.threadId, active.connection, active.requestId, "dshRuntimeFailed",
    );
    worker.active = null;
    this.finishStoppedWorker(worker, detail);
  }

  finishStoppedWorker(worker, detail) {
    console.error(`[dsh-engine] worker failed thread=${worker.threadId}: ${detail}`);
    this.stopWorker(worker);
    if (this.workers.get(worker.threadId) === worker) this.workers.delete(worker.threadId);
  }

  stopWorker(worker) {
    if (worker.startupSpan?.handle) endSpan(worker.startupSpan, "error");
    worker.lifecycle = "stopped";
    try { this.ctx.dshRuntimeHost.send(worker.processId, { type: "dispose" }); } catch {}
    this.ctx.dshRuntimeHost.stop(worker.processId, 2_000);
    worker.attachment?.detach("engineStopped");
  }

  notify(method, params) {
    this.ctx.canonicalTimeline?.recordAppServer(method, params, {
      engine: "dsh",
      kind: "execution",
    });
    this.ctx.appServer.broadcastNotification(method, params);
  }
}

DshEngineAdapterService.inject = [
  "agentCapabilityEgress", "appServer", "canonicalTimeline", "dshRuntimeHost", "threadExecution", "threadManager", "turnManager",
  "userDirectory", "workspaceAttachment", "modelGateway", "modelMetadata", "dshAppServerProjection",
  "textDeltaPacer", "dshNativeSessionStore",
];
