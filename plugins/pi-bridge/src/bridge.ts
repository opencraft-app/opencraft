/**
 * JSON-RPC command core for the Pi provider bridge.
 *
 * This layer owns protocol semantics only: it validates bridge commands,
 * delegates native work to a `PiOwnerFactory`, and emits semantic deltas
 * through a durable callback port. It never starts a second Pi session: the
 * production factory opens the existing pi-durable owner, whose lock and
 * SQLite file are the sole native writer.
 */

import { randomUUID } from "node:crypto";
import {
  BRIDGE_ERROR_CODES,
  BRIDGE_GRAMMAR_RANGE,
  BRIDGE_PROTOCOL_VERSION,
  makeBridgeError,
  negotiateHandshake,
  type BridgeCommand,
  type BridgeDeclaration,
  type BridgeDelta,
  type BridgeErrorKind,
  type BridgeInitializeResult,
  type DeliveryMethod,
} from "@opencraft/agent-bridge-protocol";
import { PiDeltaMapper, type SteerRegistration } from "./mapper.js";
import { PiSessionOpenError, type PiModelInfo, type PiOwnerFactory, type PiOwnerPort, type PiProjectedSnapshot } from "./types.js";

type Value = Record<string, any>;

export const PI_BRIDGE_DECLARATION: BridgeDeclaration = Object.freeze({
  providerId: "pi",
  protocolVersion: BRIDGE_PROTOCOL_VERSION,
  grammarRange: BRIDGE_GRAMMAR_RANGE,
  approvalExecutor: "provider",
  capabilities: {
    model: true,
    reasoning: true,
    history: true,
    usage: true,
    // Pi runs Full access here; no approval round trip is declared.
    approval: false,
    inputContentTypes: ["text"] as const,
    cliExecutable: false,
    forkCheckpoint: false,
    skills: false,
    installation: false,
    steer: {
      // The pi-durable inbox places a `mode: "steer"` input after the current
      // tool round. This is the native same-turn path; follow-up and
      // interrupt-replace are deliberately not declared.
      deliveryMethods: ["native-inject"] as const,
      // The durable owner exposes admission and the inbox/entry transition.
      // Neither proves the model consumed the text, so no context-confirmed.
      evidenceKinds: ["admission", "queue-change"] as const,
      withdrawal: "none" as const,
      contentLimits: { maxBytes: 64 * 1024, allowedContentTypes: ["text"] as const },
      maxPendingWithoutNativeId: 8,
      fallbackPolicy: "reject-unknown" as const,
    },
  },
  minNativeVersion: "1.3.0",
  probeBasis: "pi-durable 1.3.0 native inbox steer (mode: steer); OpenCraft pi-engine durable owner",
});

export class BridgeRequestError extends Error {
  constructor(
    readonly kind: BridgeErrorKind,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }

  toErrorObject(): ReturnType<typeof makeBridgeError> {
    return makeBridgeError(this.kind, this.code, this.message, this.data);
  }
}

function invalid(message: string, data?: unknown): never {
  throw new BridgeRequestError("invalid", BRIDGE_ERROR_CODES.invalidParams, message, data);
}

function unsupported(message: string): never {
  throw new BridgeRequestError("unsupported", BRIDGE_ERROR_CODES.unsupportedCapability, message);
}

function explicitReject(message: string, data?: unknown): never {
  throw new BridgeRequestError("explicit-reject", BRIDGE_ERROR_CODES.explicitReject, message, data);
}

function stale(message: string): never {
  throw new BridgeRequestError("stale-target", BRIDGE_ERROR_CODES.staleTarget, message);
}

function unknownOutcome(message: string, data?: unknown): never {
  throw new BridgeRequestError("unknown-outcome", BRIDGE_ERROR_CODES.unknownOutcome, message, data);
}

function string(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || !value || value.length > max) invalid(`${field} must be a non-empty string`);
  return value;
}

function absolute(value: unknown, field: string): string {
  const text = string(value, field, 4096);
  if (!text.startsWith("/") || text.includes("\0")) invalid(`${field} must be an absolute path`);
  return text;
}

function object(value: unknown, field: string): Value {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${field} must be an object`);
  return value as Value;
}

function textInput(value: unknown): { content: Value[]; text: string } {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? [{ type: "text", text: value }] : null;
  if (!parts || parts.length === 0 || parts.length > 64) invalid("input must be a non-empty text input array");
  const content: Value[] = [];
  let text = "";
  for (const part of parts) {
    if (!part || typeof part !== "object" || (part as Value).type !== "text" || typeof (part as Value).text !== "string") {
      // Images and mentions are not declared by this bridge. Refuse rather
      // than silently dropping a content type the client asked to send.
      unsupported("Pi bridge currently accepts text input only");
    }
    const body = (part as Value).text as string;
    if (!body.trim()) invalid("input text must not be empty");
    text += body;
    content.push({ type: "text", text: body });
  }
  if (Buffer.byteLength(text) > PI_BRIDGE_DECLARATION.capabilities.steer.contentLimits.maxBytes) {
    invalid("input exceeds the declared text limit");
  }
  return { content, text };
}

interface Runtime {
  readonly routeId: string;
  readonly owner: PiOwnerPort;
  readonly mapper: PiDeltaMapper;
  readonly callbackId: string;
  readonly starts: Map<string, { clientRequestId: string; text: string }>;
  chain: Promise<void>;
  mutations: Promise<unknown>;
  seq: number;
  closing: boolean;
  failed: string | null;
}

export type BridgeCallback = (method: "thread/delta" | "thread/identity" | "interaction/request" | "provider/recovery", params: unknown, id: string) => Promise<void>;

export interface PiBridgeOptions {
  readonly factory: PiOwnerFactory;
  readonly send: BridgeCallback;
  readonly now?: () => number;
  readonly maxHistoryTurns?: number;
}

export class PiBridge {
  private readonly sessions = new Map<string, Runtime>();
  private readonly incarnation = randomUUID();
  private lifecycle: Promise<unknown> = Promise.resolve();
  private closing = false;
  private readonly factory: PiOwnerFactory;
  private readonly send: BridgeCallback;
  private readonly now: () => number;
  private readonly maxHistoryTurns: number;

  constructor(options: PiBridgeOptions) {
    this.factory = options.factory;
    this.send = options.send;
    this.now = options.now ?? (() => Date.now());
    this.maxHistoryTurns = options.maxHistoryTurns ?? 50;
  }

  initialize(params: unknown): BridgeInitializeResult {
    const value = object(params, "initialize params");
    const protocolVersion = value.protocolVersion;
    const grammarRange = value.grammarRange;
    if (typeof protocolVersion !== "number" || !grammarRange || typeof grammarRange !== "object") {
      invalid("initialize needs protocolVersion and grammarRange");
    }
    const outcome = negotiateHandshake(
      { protocolVersion, grammarRange: grammarRange as { min: number; max: number } },
      PI_BRIDGE_DECLARATION,
    );
    if (!outcome.ok) throw new BridgeRequestError("unsupported", outcome.error.code, outcome.error.message, outcome.error.data);
    return outcome.result;
  }

  async command(method: BridgeCommand, params: unknown): Promise<unknown> {
    if (this.closing) throw new BridgeRequestError("internal", BRIDGE_ERROR_CODES.internal, "Bridge closing");
    const value = object(params, `${method} params`);
    switch (method) {
      case "model/list":
        return { data: await this.factory.models(), nextCursor: null };
      case "session/create":
        return this.serialLifecycle(() => this.create(value));
      case "session/resume":
        return this.serialLifecycle(() => this.resume(value));
      case "session/close": {
        const runtime = this.runtime(value);
        return this.serialLifecycle(() => this.serial(runtime, () => this.closeSession(value)));
      }
      case "turn/start": {
        const runtime = this.runtime(value);
        return this.serial(runtime, () => this.start(value));
      }
      case "turn/steer": {
        const runtime = this.runtime(value);
        return this.serial(runtime, () => this.steer(value));
      }
      case "turn/stop": {
        const runtime = this.runtime(value);
        return this.serial(runtime, () => this.stop(value));
      }
      case "input/query":
        return this.query(value);
      case "input/withdraw":
        unsupported("Pi bridge does not declare native or pre-dispatch withdrawal");
      case "history/read":
        return this.history(value);
      case "maintenance/probe":
        return {
          providerId: "pi",
          nativeVersion: PI_BRIDGE_DECLARATION.minNativeVersion,
          owner: "pi-durable",
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          activeSessions: [...this.sessions.values()].filter(runtime => !runtime.failed).length,
          pid: process.pid,
        };
      case "interaction/resolve":
        unsupported("Pi bridge declares no approval interactions");
      case "skills/configure":
      case "installation/status":
      case "installation/run":
        unsupported(`Pi bridge does not declare ${method}`);
      default:
        unsupported(`Unsupported Pi bridge command ${String(method)}`);
    }
  }

  private runtime(value: Value): Runtime {
    const routeId = string(value.threadId, "threadId");
    const runtime = this.sessions.get(routeId);
    if (!runtime) explicitReject("No bridge-owned Pi session for this thread", { threadId: routeId });
    if (runtime.failed) throw new BridgeRequestError("internal", BRIDGE_ERROR_CODES.internal, runtime.failed);
    return runtime;
  }

  private async create(value: Value): Promise<unknown> {
    const routeId = string(value.threadId, "threadId");
    const cwd = absolute(value.cwd, "cwd");
    const model = modelParam(value.model);
    const thinkingLevel = value.thinkingLevel === undefined ? undefined : string(value.thinkingLevel, "thinkingLevel", 64);
    const baseInstructions = value.baseInstructions === undefined ? undefined : string(value.baseInstructions, "baseInstructions", 200_000);
    const developerInstructions = value.developerInstructions === undefined ? undefined : string(value.developerInstructions, "developerInstructions", 200_000);
    const existing = this.sessions.get(routeId);
    if (existing) {
      // The Host command ledger normally prevents this. If a client retries a
      // create after an ambiguous outcome, never open a second writer.
      const requestedThinking = thinkingLevel === "none" ? "off" : thinkingLevel;
      if (existing.owner.info.cwd === cwd
        && modelMatches(existing.owner.info.model, model)
        && (requestedThinking === undefined || existing.owner.info.thinkingLevel === requestedThinking)
        && (baseInstructions === undefined || existing.owner.info.baseInstructions === baseInstructions)
        && (developerInstructions === undefined || existing.owner.info.developerInstructions === developerInstructions)) {
        return { threadId: routeId, providerThreadId: existing.owner.info.nativeSessionId, model: existing.owner.info.model, cwd };
      }
      explicitReject("Thread already belongs to a different native Pi session", { threadId: routeId });
    }
    let owner: PiOwnerPort;
    try {
      owner = await this.factory.create({ routeId, cwd, model, thinkingLevel, baseInstructions, developerInstructions });
    } catch (error) {
      rejectSessionOpen(error);
    }
    if (this.closing) {
      await this.factory.close(owner).catch(() => {});
      throw new BridgeRequestError("internal", BRIDGE_ERROR_CODES.internal, "Bridge closing");
    }
    const runtime: Runtime = {
      routeId,
      owner,
      mapper: new PiDeltaMapper({ threadId: routeId, nativeSessionId: owner.info.nativeSessionId, now: this.now }),
      callbackId: randomUUID(),
      starts: new Map(),
      chain: Promise.resolve(),
      mutations: Promise.resolve(),
      seq: 0,
      closing: false,
      failed: null,
    };
    this.sessions.set(routeId, runtime);
    this.attach(runtime);
    try {
      await this.emitIdentity(runtime);
      await this.refresh(runtime);
      owner.setSnapshotListener(snapshot => this.onSnapshot(runtime, snapshot));
      await this.refresh(runtime);
    } catch (error) {
      this.sessions.delete(routeId);
      await this.factory.close(owner).catch(() => {});
      throw error;
    }
    return { threadId: routeId, providerThreadId: owner.info.nativeSessionId, model: owner.info.model, cwd: owner.info.cwd };
  }

  private async resume(value: Value): Promise<unknown> {
    const routeId = string(value.threadId, "threadId");
    if (this.sessions.has(routeId)) {
      const runtime = this.sessions.get(routeId)!;
      if (runtime.failed) throw new BridgeRequestError("internal", BRIDGE_ERROR_CODES.internal, runtime.failed);
      return { threadId: routeId, providerThreadId: runtime.owner.info.nativeSessionId, model: runtime.owner.info.model, cwd: runtime.owner.info.cwd };
    }
    let owner: PiOwnerPort;
    try {
      owner = await this.factory.resume({ routeId });
    } catch (error) {
      rejectSessionOpen(error);
    }
    if (this.closing) {
      await this.factory.close(owner).catch(() => {});
      throw new BridgeRequestError("internal", BRIDGE_ERROR_CODES.internal, "Bridge closing");
    }
    const runtime: Runtime = {
      routeId,
      owner,
      mapper: new PiDeltaMapper({ threadId: routeId, nativeSessionId: owner.info.nativeSessionId, now: this.now }),
      callbackId: randomUUID(),
      starts: new Map(),
      chain: Promise.resolve(),
      mutations: Promise.resolve(),
      seq: 0,
      closing: false,
      failed: null,
    };
    this.sessions.set(routeId, runtime);
    this.attach(runtime);
    try {
      await this.emitIdentity(runtime);
      const baseline = await owner.snapshot();
      runtime.mapper.seed(baseline);
      owner.setSnapshotListener(snapshot => this.onSnapshot(runtime, snapshot));
      if (baseline.activeTurnId !== null) {
        await this.emitRecovery(runtime, "staleTurn",
          "Native Pi session resumed; existing native turns are not replayed. Hydrate history from the Host projection before relying on this turn.", false);
      }
      await this.refresh(runtime);
    } catch (error) {
      this.sessions.delete(routeId);
      await this.factory.close(owner).catch(() => {});
      throw error;
    }
    return { threadId: routeId, providerThreadId: owner.info.nativeSessionId, model: owner.info.model, cwd: owner.info.cwd };
  }

  private attach(runtime: Runtime): void {
    runtime.owner.setExitListener(error => {
      runtime.failed = `Pi native owner exited: ${error.message}`;
      void this.emitRecovery(runtime, "restartRecommended", error.message, false);
    });
  }

  private async start(value: Value): Promise<unknown> {
    const runtime = this.runtime(value);
    const inputId = string(value.inputId ?? value.clientRequestId, "inputId");
    const clientRequestId = string(value.clientRequestId ?? inputId, "clientRequestId");
    if (runtime.mapper.hasInput(inputId)) explicitReject("Input identity already belongs to a steering input", { inputId });
    const { content, text } = textInput(value.input);
    const prior = runtime.starts.get(inputId);
    if (prior && (prior.clientRequestId !== clientRequestId || prior.text !== text)) {
      explicitReject("Input identity already belongs to different content", { inputId });
    }
    const nativePrior = await runtime.owner.execution(inputId);
    if (nativePrior !== null) {
      if (nativePrior === "completed") return { threadId: runtime.routeId, inputId, turnId: inputId, accepted: true, duplicate: true, state: "evidence-observed" };
      if (nativePrior === "running") explicitReject("Pi conversation is busy; use turn/steer", { inputId });
      explicitReject("Previous input failed; reconcile before retrying", { inputId });
    }
    const current = await runtime.owner.snapshot();
    if (current.activeTurnId !== null) explicitReject("Pi conversation is busy; use turn/steer", { activeTurnId: current.activeTurnId });
    const data = {
      turnId: inputId,
      input: content,
      clientId: clientRequestId,
      sourceKind: "user",
      createdAtMs: this.now(),
    };
    try {
      await runtime.owner.submit(content, data, inputId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/busy|not idle|already/i.test(message)) explicitReject(message, { inputId });
      // A durable submit may have committed even when its caller observed an
      // error. The Host must reconcile the same command; it must not resend.
      unknownOutcome(message, { inputId });
    }
    runtime.starts.set(inputId, { clientRequestId, text });
    void this.refresh(runtime).catch(error => this.fail(runtime, error));
    return { threadId: runtime.routeId, inputId, turnId: inputId, accepted: true };
  }

  private async steer(value: Value): Promise<unknown> {
    const runtime = this.runtime(value);
    const inputId = string(value.inputId ?? value.clientRequestId, "inputId");
    const clientRequestId = string(value.clientRequestId ?? inputId, "clientRequestId");
    const expectedTurnId = string(value.expectedTurnId, "expectedTurnId");
    const { content, text } = textInput(value.input);
    const registration: SteerRegistration = { inputId, clientRequestId, expectedTurnId, text };
    const { duplicate, conflict } = runtime.mapper.registerSteer(registration);
    if (conflict) explicitReject("Client input identity already belongs to different input", { inputId });
    if (duplicate) {
      const existing = runtime.mapper.query(inputId);
      if (existing?.state === "unknown") {
        unknownOutcome(existing.reason ?? "Previous steer outcome is unknown; reconcile before retrying", { inputId });
      }
      if (existing?.state === "failed") {
        if (existing.failureKind === "stale-target") stale(existing.reason ?? "Pi turn identity changed");
        explicitReject(existing.reason ?? "Input previously failed", { inputId, state: existing.state });
      }
      return { threadId: runtime.routeId, inputId, duplicate: true, state: existing?.state ?? null };
    }
    const data = {
      turnId: expectedTurnId,
      steerTurnId: expectedTurnId,
      input: content,
      clientId: clientRequestId,
      sourceKind: "user",
      createdAtMs: this.now(),
    };
    try {
      await runtime.owner.steer(content, data, inputId, expectedTurnId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/turn identity changed|no active|not pending|already been dispatched/i.test(message)) {
        await this.emit(runtime, runtime.mapper.acceptedDeltas(registration, false));
        runtime.mapper.noteFailure(inputId, "rejected", message, "stale-target");
        stale(message);
      }
      await this.emit(runtime, runtime.mapper.acceptedDeltas(registration, true));
      await this.emit(runtime, runtime.mapper.outcomeDeltas(inputId, "unknown", message, "unknown-outcome"));
      unknownOutcome(message, { inputId });
    }
    try {
      await this.emit(runtime, runtime.mapper.acceptedDeltas(registration, true, "native-inject" as DeliveryMethod));
      // The durable admission itself is evidence-observed, not context proof.
      await this.emit(runtime, runtime.mapper.evidenceDeltas(inputId, "admission", `pi-submission:${inputId}`));
    } catch (error) {
      // The native write succeeded but the Host custody did not. Keep the
      // command unknown and fence the session; never replay the steer.
      this.fail(runtime, error);
      unknownOutcome(error instanceof Error ? error.message : String(error), { inputId });
    }
    void this.refresh(runtime).catch(error => this.fail(runtime, error));
    return { threadId: runtime.routeId, inputId, accepted: true, deliveryMethod: "native-inject", evidence: "admission" };
  }

  private async stop(value: Value): Promise<unknown> {
    const runtime = this.runtime(value);
    try {
      await runtime.owner.abort();
    } catch (error) {
      unknownOutcome(error instanceof Error ? error.message : String(error));
    }
    await this.refresh(runtime).catch(error => this.fail(runtime, error));
    return { threadId: runtime.routeId, stopped: true };
  }

  private async query(value: Value): Promise<unknown> {
    const runtime = this.runtime(value);
    const inputId = string(value.inputId, "inputId");
    const tracked = runtime.mapper.query(inputId);
    if (tracked) return tracked;
    const native = await runtime.owner.execution(inputId);
    return {
      inputId,
      state: native === "running" ? "admitted" : native === "completed" ? "evidence-observed" : native === "failed" ? "failed" : "unknown",
      evidenceKind: null,
      version: 0,
      native,
    };
  }

  private async history(value: Value): Promise<unknown> {
    const runtime = this.runtime(value);
    const limit = value.limit === undefined ? 20 : Number(value.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxHistoryTurns) invalid("history limit is out of range");
    const snapshot = await runtime.owner.snapshot();
    const turns = snapshot.turns.slice(-limit).map(turn => ({
      nativeTurnId: String(turn.id),
      status: String(turn.status),
      items: (turn.items as Value[]).slice(0, 200).map(item => ({
        kind: String(item.type),
        ...(typeof item.text === "string" ? { text: item.text.slice(0, 16_384) } : {}),
        ...(typeof item.tool === "string" ? { tool: item.tool, status: item.status } : {}),
        ...(typeof item.command === "string" ? { command: item.command.slice(0, 4096), status: item.status } : {}),
      })),
    }));
    return { threadId: runtime.routeId, turns };
  }

  private async closeSession(value: Value): Promise<unknown> {
    const runtime = this.runtime(value);
    await runtime.chain.catch(() => {});
    const snapshot = await runtime.owner.snapshot();
    if (snapshot.activeTurnId !== null) explicitReject("Stop the active Pi turn before closing the session", { activeTurnId: snapshot.activeTurnId });
    runtime.owner.setSnapshotListener(() => {});
    await this.emit(runtime, runtime.mapper.sessionEnded("session closed"));
    runtime.closing = true;
    await this.factory.close(runtime.owner);
    this.sessions.delete(runtime.routeId);
    return { threadId: runtime.routeId, closed: true };
  }

  /** Serialize session lifecycle (create/resume/close) across routes. */
  private serialLifecycle<T>(task: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(task, task);
    this.lifecycle = next.catch(() => {});
    return next;
  }

  private serial<T>(runtime: Runtime, task: () => Promise<T>): Promise<T> {
    const next = runtime.mutations.then(task, task);
    runtime.mutations = next.catch(() => {});
    return next;
  }

  private refresh(runtime: Runtime): Promise<void> {
    const task = async () => {
      const snapshot = await runtime.owner.snapshot();
      await this.onSnapshotNow(runtime, snapshot);
    };
    const next = runtime.chain.then(task, task);
    runtime.chain = next.catch(() => {});
    return next;
  }

  private onSnapshot(runtime: Runtime, snapshot: PiProjectedSnapshot): void {
    if (runtime.closing || runtime.failed) return;
    const task = () => this.onSnapshotNow(runtime, snapshot);
    const next = runtime.chain.then(task, task);
    runtime.chain = next.catch(() => {});
    void next.catch(error => this.fail(runtime, error));
  }

  private async onSnapshotNow(runtime: Runtime, snapshot: PiProjectedSnapshot): Promise<void> {
    const deltas = runtime.mapper.diff(snapshot);
    await this.emit(runtime, deltas);
  }

  private async emit(runtime: Runtime, deltas: readonly BridgeDelta[]): Promise<void> {
    if (deltas.length === 0 || runtime.closing) return;
    // Keep each callback comfortably below the Host's 1 MiB JSONL frame cap.
    // Order is preserved across the split batches; an individual oversized
    // delta still fails the session rather than being silently truncated.
    const batches: BridgeDelta[][] = [];
    let batch: BridgeDelta[] = [];
    for (const delta of deltas) {
      batch.push(delta);
      if (Buffer.byteLength(JSON.stringify(batch)) > 512 * 1024) {
        const last = batch.pop()!;
        if (batch.length) batches.push(batch);
        batch = [last];
      }
    }
    if (batch.length) batches.push(batch);
    for (const deltas of batches) {
      await this.send("thread/delta", { threadId: runtime.routeId, deltas }, `${runtime.callbackId}:delta:${++runtime.seq}`);
    }
  }

  private async emitIdentity(runtime: Runtime): Promise<void> {
    await this.send(
      "thread/identity",
      {
        threadId: runtime.routeId,
        providerThreadId: runtime.owner.info.nativeSessionId,
        sessionRestorable: true,
      },
      `identity:${runtime.routeId}`,
    );
  }

  private async emitRecovery(runtime: Runtime, kind: "restartRecommended" | "staleTurn", message: string, retryable: boolean): Promise<void> {
    await this.send(
      "provider/recovery",
      { threadId: runtime.routeId, kind, message, retryable },
      `${this.incarnation}:recovery:${runtime.routeId}:${randomUUID()}`,
    ).catch(() => {});
  }

  private fail(runtime: Runtime, error: unknown): void {
    if (runtime.closing || runtime.failed) return;
    runtime.failed = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pi-bridge: session ${runtime.routeId} failed: ${runtime.failed}\n`);
    void this.emitRecovery(runtime, "restartRecommended", runtime.failed, false);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const runtimes = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(runtimes.map(async runtime => {
      runtime.closing = true;
      runtime.owner.setSnapshotListener(() => {});
      await runtime.chain.catch(() => {});
      await runtime.owner.close().catch(() => {});
    }));
  }
}

function rejectSessionOpen(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PiSessionOpenError) explicitReject(message, { failure: error.failure });
  // Session-open failures are deterministic: a pinned model is unavailable,
  // an existing native file must not be adopted, or another writer holds the
  // lock. They are explicit rejections, not ambiguous native outcomes.
  if (/(?:^|[^a-z])unavailable|already exists|Orphaned|must be|does not support|No bridge-owned|metadata|already being held|\bELOCKED\b/i.test(message)) {
    explicitReject(message);
  }
  throw error;
}

function modelParam(value: unknown): string | { provider: string; modelId: string } {
  if (typeof value === "string") {
    const text = string(value, "model");
    if (/^pi:[^:]+:.+$/u.test(text) || /^[^/]+\/.+$/u.test(text)) return text;
    invalid("model must be pi:provider:model, provider/model, or {provider,modelId}");
  }
  const model = object(value, "model");
  return { provider: string(model.provider, "model.provider", 128), modelId: string(model.modelId, "model.modelId", 256) };
}

function modelMatches(left: { provider: string; modelId: string }, right: string | { provider: string; modelId: string }): boolean {
  if (typeof right === "string") {
    const match = /^pi:([^:]+):(.+)$/u.exec(right) ?? /^([^/]+)\/(.+)$/u.exec(right);
    return !!match && decodeURIComponent(match[1]!) === left.provider && decodeURIComponent(match[2]!) === left.modelId;
  }
  return right.provider === left.provider && right.modelId === left.modelId;
}

export type { PiModelInfo };
