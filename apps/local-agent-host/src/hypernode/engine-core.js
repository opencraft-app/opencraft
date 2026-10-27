export function createImplementation(Date, addSpanEvent, endSpan) {
function streamedAgentStartItem(item) { return { ...item, text: "" }; }
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
return class HypernodeDshEngineCore {
constructor(ctx){this.ctx=ctx;this.workers=new Map();}
stopWorker(worker){worker.lifecycle="stopped";this.ctx.stopWorker(worker);}
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
notify(method, params) {
    this.ctx.canonicalTimeline?.recordAppServer(method, params, {
      engine: "dsh",
      kind: "execution",
    });
    this.ctx.appServer.broadcastNotification(method, params);
  }
};
}
