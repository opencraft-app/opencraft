/**
 * Generic ACP provider bridge.
 *
 * Wire shape: the P1a bridge protocol on stdio (JSONL) toward the Engine Host,
 * ACP JSON-RPC toward one installed agent process per Thread. The bridge owns
 * native session lifetime, translates ACP updates into semantic deltas, records
 * the path each steer input actually took, and routes undecided permission
 * requests into the existing `interaction/request` channel. It never claims
 * model-context evidence from an ACP admission, and it never auto-degrades a
 * steer to a cancel-and-resend path.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  BRIDGE_ERROR_CODES,
  negotiateHandshake,
  type BridgeDeclaration,
  type BridgeDelta,
  type BridgeErrorKind,
  type BridgeInitializeResult,
  type DeclaredCapabilities,
  type DeliveryMethod,
  type EvidenceKind,
} from "@opencraft/agent-bridge-protocol";
import {
  AcpConnection,
  AcpConnectionClosedError,
  AcpRpcError,
  parseNewSessionResult,
  parsePromptResult,
  type AcpConfigOption,
  type AcpInitializeResult,
  type AcpNewSessionResult,
} from "./acp";
import {
  resolveAcpDialect,
  type AcpDialect,
  type AcpPermissionPlan,
} from "./dialect";
import {
  approvalPayload,
  chooseOption,
  newInteractionId,
  parsePermissionRequest,
  policyDecision,
  resolvePermission,
  type AcpPermissionOption,
  type PermissionDecision,
} from "./permissions";
import {
  declarationFor,
  isPermissionMode,
  type AcpProfile,
  type OpenCraftPermissionMode,
} from "./profile";
import {
  AcpDeltaTranslator,
  parsePromptInput,
  toAcpPrompt,
  type AcpPromptInput,
} from "./translate";

export class BridgeCommandError extends Error {
  constructor(
    readonly kind: BridgeErrorKind,
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "BridgeCommandError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new BridgeCommandError("invalid", BRIDGE_ERROR_CODES.invalidParams, "params must be an object");
  return value;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new BridgeCommandError("invalid", BRIDGE_ERROR_CODES.invalidParams, `${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function unsupported(message: string): BridgeCommandError {
  return new BridgeCommandError("unsupported", BRIDGE_ERROR_CODES.unsupportedCapability, message);
}

function invalid(message: string): BridgeCommandError {
  return new BridgeCommandError("invalid", BRIDGE_ERROR_CODES.invalidParams, message);
}

function explicitReject(message: string): BridgeCommandError {
  return new BridgeCommandError("explicit-reject", BRIDGE_ERROR_CODES.explicitReject, message);
}

function staleTarget(message: string): BridgeCommandError {
  return new BridgeCommandError("stale-target", BRIDGE_ERROR_CODES.staleTarget, message);
}

function unknownOutcome(message: string): BridgeCommandError {
  return new BridgeCommandError("unknown-outcome", BRIDGE_ERROR_CODES.unknownOutcome, message);
}

export type CallbackMethod = "thread/delta" | "thread/identity" | "interaction/request";

export interface AcpBridgeOptions {
  readonly profile: AcpProfile;
  readonly requestCallback: (method: CallbackMethod, params: Record<string, unknown>) => Promise<unknown>;
  readonly onDiagnostic?: (line: string) => void;
  readonly onFrame?: (direction: "in" | "out", frame: unknown) => void;
  readonly now?: () => number;
}

interface NativeSteerAttempt {
  readonly inputId: string;
  text: string;
  settled: boolean;
  terminal: boolean;
}

interface ActiveTurn {
  readonly nativeTurnId: string;
  readonly translator: AcpDeltaTranslator;
  readonly steerAttempts: Map<string, NativeSteerAttempt>;
  replacement?: QueuedInput;
  promptSettled: Promise<void>;
}

interface QueuedInput {
  readonly record: InputRecord;
  readonly input: AcpPromptInput;
  readonly delivery: Exclude<DeliveryMethod, "native-inject">;
}

type AdmissionValue = "none" | "accepted" | "rejected" | "failed" | "unknown";
type EvidenceValue = "none" | "evidence-observed" | "context-confirmed";
type WithdrawalValue = "none" | "withdrawn" | "too-late" | "unknown";

interface InputRecord {
  readonly inputId: string;
  readonly clientRequestId: string;
  targetNativeTurnId: string | null;
  readonly allowedPaths: readonly DeliveryMethod[];
  readonly fallbackPolicy: "reject-unknown";
  readonly requestedDelivery: DeliveryMethod | null;
  accepted: boolean;
  queued: boolean;
  dispatched: boolean;
  terminal: boolean;
  nativeExecution: boolean;
  admission: { value: AdmissionValue; version: number };
  delivery: { value: "none" | DeliveryMethod; version: number };
  evidence: { value: EvidenceValue; version: number; kind?: EvidenceKind };
  withdrawal: { value: WithdrawalValue; version: number };
  outcome: string;
}

interface PendingInteraction {
  readonly options: readonly AcpPermissionOption[];
  resolve(decision: PermissionDecision): void;
}

class AcpSession {
  readonly inputs = new Map<string, InputRecord>();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly resolvedInteractions = new Set<string>();
  private connection: AcpConnection | null = null;
  private initializeResult: AcpInitializeResult | null = null;
  private newSession: AcpNewSessionResult | null = null;
  private permissionPlan: AcpPermissionPlan | null = null;
  private modelSelection: { configOptionId: string; value: string } | null = null;
  private active: ActiveTurn | null = null;
  private readonly queue: QueuedInput[] = [];
  private deliveryMethods: DeliveryMethod[] = [];
  private imagesAllowed = false;
  private cwd = process.cwd();
  private closing = false;
  private closed = false;
  private agentExited = false;
  private startingTurn = false;
  private opened = false;

  constructor(
    private readonly host: AcpBridge,
    readonly threadId: string,
    private readonly profile: AcpProfile,
    private readonly dialect: AcpDialect,
    private readonly effective: DeclaredCapabilities,
  ) {}

  get nativeSteering(): boolean {
    return this.deliveryMethods.includes("native-inject");
  }

  get sessionId(): string | null {
    return this.newSession?.sessionId ?? null;
  }

  async open(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cwd = optionalString(params.cwd) ?? this.profile.agent.cwd;
    if (!isAbsolute(cwd)) throw invalid("session/create cwd must be absolute");
    this.cwd = cwd;
    const requestedMode = params.permissionMode === undefined
      ? this.profile.defaultPermissionMode
      : isPermissionMode(params.permissionMode)
        ? params.permissionMode
        : (() => { throw invalid("unknown permissionMode"); })();
    const requestedModel = optionalString(params.modelSelection) ?? this.profile.modelSelection;

    const connection = new AcpConnection({
      command: this.profile.agent.command,
      args: this.profile.agent.args,
      cwd,
      ...(this.profile.agent.env === undefined ? {} : { env: this.profile.agent.env }),
      onRequest: (method, requestParams) => this.onAgentRequest(method, requestParams),
      onNotification: (method, notificationParams) => this.onAgentNotification(method, notificationParams),
      onDiagnostic: (line) => this.host.diagnostic(`acp(${this.profile.providerId}) ${line}`),
      onFrame: (direction, frame) => this.host.traceFrame(direction, frame),
      onExit: (error) => this.onAgentExit(error),
      requestTimeoutMs: 30_000,
    });
    this.connection = connection;
    try {
      connection.spawn();
      const initialize = await connection.initialize();
      if (initialize.protocolVersion !== 1) throw unsupported(`ACP protocol ${initialize.protocolVersion} is not supported`);
      this.initializeResult = initialize;
      this.imagesAllowed = initialize.agentCapabilities?.promptCapabilities?.image === true;
      const rawSession = await connection.request("session/new", { cwd, mcpServers: [] });
      const newSession = parseNewSessionResult(rawSession);
      this.newSession = newSession;
      const context = { initialize, session: newSession };
      const native = this.dialect.nativeSteering(context) && this.effective.steer.deliveryMethods.includes("native-inject");
      this.deliveryMethods = this.effective.steer.deliveryMethods.filter((method) =>
        method !== "native-inject" || native);
      this.permissionPlan = this.dialect.permissionPlan(requestedMode, context);
      if (requestedModel !== undefined) {
        this.modelSelection = this.dialect.modelPlan(requestedModel, context);
        if (this.modelSelection === null) {
          throw unsupported(`the installed agent did not advertise a model selector for ${requestedModel}`);
        }
      }
      await this.applyPermissionPlan(this.permissionPlan);
      if (this.modelSelection !== null) {
        await this.setConfigOption(this.modelSelection.configOptionId, this.modelSelection.value);
      }
      this.opened = true;
      await this.host.callback("thread/identity", {
        threadId: this.threadId,
        providerThreadId: newSession.sessionId,
        sessionRestorable: false,
      });
      return {
        providerThreadId: newSession.sessionId,
        permission: this.permissionPlan,
        model: this.modelSelection,
        capabilities: {
          images: this.imagesAllowed,
          nativeSteering: this.nativeSteering,
          deliveryMethods: this.deliveryMethods,
        },
      };
    } catch (error) {
      this.closed = true;
      await connection.close().catch(() => {});
      throw error instanceof BridgeCommandError ? error : invalid(
        `ACP session could not be created: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async applyPermissionPlan(plan: AcpPermissionPlan): Promise<void> {
    if (this.connection === null || this.newSession === null) throw invalid("session is not open");
    if (plan.nativeModeId !== undefined) {
      await this.connection.request("session/set_mode", {
        sessionId: this.newSession.sessionId,
        modeId: plan.nativeModeId,
      });
    }
    for (const option of plan.configOptions) {
      await this.setConfigOption(option.id, option.value);
    }
  }

  private async setConfigOption(configId: string, value: string): Promise<void> {
    if (this.connection === null || this.newSession === null) throw invalid("session is not open");
    await this.connection.request("session/set_config_option", {
      sessionId: this.newSession.sessionId,
      configId,
      value,
    });
  }

  private promptLimits(): { maxBytes: number; imagesAllowed: boolean } {
    return {
      maxBytes: this.effective.steer.contentLimits.maxBytes,
      imagesAllowed: this.imagesAllowed,
    };
  }

  private base(): { scope: { threadId: string }; nativeTurnId?: string } {
    return this.active === null
      ? { scope: { threadId: this.threadId } }
      : { scope: { threadId: this.threadId }, nativeTurnId: this.active.nativeTurnId };
  }

  private async emit(deltas: readonly BridgeDelta[]): Promise<void> {
    if (deltas.length === 0) return;
    try {
      await this.host.emitDeltas(this.threadId, deltas);
    } catch (error) {
      // Persistence loss ends execution custody. The Host will fence the
      // Thread; the bridge must not keep a native turn without an owner.
      this.host.diagnostic(`delta delivery failed: ${error instanceof Error ? error.message : String(error)}`);
      this.closing = true;
    }
  }

  async startTurn(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.opened || this.closed || this.closing || this.agentExited) throw staleTarget("ACP session is not open");
    if (this.startingTurn) throw staleTarget("a turn is already starting");
    if (this.active !== null) throw staleTarget("a turn is already running; use turn/steer");
    if (this.queue.length > 0) throw staleTarget("a queued next-turn input is still pending");
    this.startingTurn = true;
    try {
      return await this.startTurnLocked(params);
    } finally {
      this.startingTurn = false;
    }
  }

  private async startTurnLocked(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = this.parseInput(params.input);
    const requestedMode = params.permissionMode === undefined
      ? undefined
      : isPermissionMode(params.permissionMode)
        ? params.permissionMode
        : (() => { throw invalid("unknown permissionMode"); })();
    if (requestedMode !== undefined && requestedMode !== this.permissionPlan?.requested) {
      const plan = this.dialect.permissionPlan(requestedMode, {
        initialize: this.initializeResult!,
        session: this.newSession!,
      });
      await this.applyPermissionPlan(plan);
      this.permissionPlan = plan;
    }
    if (this.closed || this.closing || this.agentExited || this.active !== null) {
      throw staleTarget("the ACP session changed while the turn was starting");
    }
    const inputId = optionalString(params.inputId) ?? `input:${randomUUID()}`;
    const clientRequestId = optionalString(params.clientRequestId) ?? inputId;
    const nativeTurnId = this.startNativeTurn(input, inputId, clientRequestId, null);
    return { nativeTurnId, inputId };
  }

  private startNativeTurn(
    input: AcpPromptInput,
    inputId: string,
    clientRequestId: string,
    queued: QueuedInput | null,
  ): string {
    if (this.connection === null || this.newSession === null) throw staleTarget("ACP session is not open");
    if (this.closing || this.closed || this.agentExited) throw staleTarget("ACP session is closing");
    if (!this.connection.writable) throw staleTarget("ACP agent is not writable");
    const nativeTurnId = `acp:${randomUUID()}`;
    const translator = new AcpDeltaTranslator({
      threadId: this.threadId,
      nativeTurnId,
      cwd: this.cwd,
    });
    const turn: ActiveTurn = {
      nativeTurnId,
      translator,
      steerAttempts: new Map(),
      promptSettled: Promise.resolve(),
    };
    this.active = turn;
    void this.emit([
      { scope: { threadId: this.threadId }, op: "turn.open", nativeTurnId },
      { scope: { threadId: this.threadId }, op: "turn.mainRun", state: "running" },
    ]);
    const prompt = toAcpPrompt(input, this.imagesAllowed);
    const response = this.connection.request("session/prompt", {
      sessionId: this.newSession.sessionId,
      prompt,
    }, { timeoutMs: 0 });
    if (queued !== null) {
      const record = queued.record;
      record.targetNativeTurnId = nativeTurnId;
      if (!this.connection.writable) {
        record.terminal = true;
        record.queued = false;
        record.outcome = "unknown";
      } else {
        this.emitAccepted(record, nativeTurnId, queued.delivery);
        void this.emit([
          {
            scope: { threadId: this.threadId }, nativeTurnId,
            op: "input.delivery",
            inputId: record.inputId,
            deliveryMethod: queued.delivery,
            admitted: true,
            version: ++record.delivery.version,
          },
          {
            scope: { threadId: this.threadId }, nativeTurnId,
            op: "input.evidence",
            inputId: record.inputId,
            evidenceKind: "admission",
            version: ++record.evidence.version,
          },
        ]).then(() => {
          record.admission = { value: "accepted", version: record.admission.version + 1 };
          record.delivery.value = queued.delivery;
          record.evidence = { value: "evidence-observed", version: record.evidence.version, kind: "admission" };
          record.outcome = "delivered";
        });
        record.dispatched = true;
        record.queued = false;
        record.nativeExecution = true;
      }
    }
    turn.promptSettled = response.then(
      (value) => {
        try {
          return this.settleTurn(turn, { stopReason: parsePromptResult(value).stopReason });
        } catch (error) {
          return this.settleTurn(turn, { error: error instanceof Error ? error : new Error(String(error)) });
        }
      },
      (error: unknown) => this.settleTurn(turn, { error: error instanceof Error ? error : new Error(String(error)) }),
    );
    return nativeTurnId;
  }

  private async settleTurn(
    turn: ActiveTurn,
    outcome: { stopReason?: string; error?: Error },
  ): Promise<void> {
    if (this.active !== turn) return;
    this.active = null;
    const status = outcome.error !== undefined
      ? "failed"
      : outcome.stopReason === "cancelled"
        ? "interrupted"
        : outcome.stopReason === "end_turn"
          ? "completed"
          : "failed";
    for (const attempt of turn.steerAttempts.values()) {
      if (!attempt.settled) {
        attempt.settled = true;
        attempt.terminal = true;
        const record = this.inputs.get(attempt.inputId);
        if (record !== undefined && !record.terminal) {
          record.admission = { value: "unknown", version: record.admission.version + 1 };
          record.outcome = "unknown";
          record.terminal = true;
          await this.emit([{
            scope: { threadId: this.threadId }, nativeTurnId: turn.nativeTurnId,
            op: "input.outcome",
            inputId: attempt.inputId,
            state: "unknown",
            reason: "the target ACP turn settled before native steering admission was confirmed",
            version: record.admission.version,
          }]);
        }
      }
    }
    await this.emit(turn.translator.finish(status));
    if (outcome.error !== undefined) {
      await this.emit([{
        scope: { threadId: this.threadId }, nativeTurnId: turn.nativeTurnId,
        op: "provider.recovery",
        kind: "staleTurn",
        message: `ACP turn outcome is unknown: ${outcome.error.message}. Do not resend the native prompt; query the original input.`,
        retryable: false,
      }]);
    }
    if (turn.replacement !== undefined) {
      const replacement = turn.replacement;
      const record = replacement.record;
      record.queued = false;
      try {
        this.startNativeTurn(replacement.input, record.inputId, record.clientRequestId, replacement);
      } catch (error) {
        record.terminal = true;
        record.outcome = "unknown";
        this.host.diagnostic(`replacement turn could not start: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    this.dispatchQueue();
  }

  private dispatchQueue(): void {
    if (this.active !== null || this.closing || this.closed) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    if (next.record.terminal) {
      this.dispatchQueue();
      return;
    }
    next.record.queued = false;
    try {
      this.startNativeTurn(next.input, next.record.inputId, next.record.clientRequestId, next);
    } catch (error) {
      next.record.terminal = true;
      next.record.outcome = "unknown";
      this.host.diagnostic(`queued turn could not start: ${error instanceof Error ? error.message : String(error)}`);
      this.dispatchQueue();
    }
  }

  async steer(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.opened || this.closed || this.agentExited) throw staleTarget("ACP session is not open");
    const active = this.active;
    if (active === null) throw staleTarget("no active turn to steer");
    const expected = optionalString(params.expectedTurnId);
    if (expected !== undefined && expected !== active.nativeTurnId) {
      throw staleTarget("expectedTurnId does not match the active native turn");
    }
    const input = this.parseInput(params.input);
    const requestedDelivery = optionalString(params.delivery);
    let delivery: DeliveryMethod;
    if (requestedDelivery === undefined) {
      if (!this.nativeSteering) {
        throw explicitReject("the installed agent did not declare native mid-turn steering; choose next-turn or interrupt-replace explicitly");
      }
      delivery = "native-inject";
    } else {
      if (requestedDelivery !== "native-inject" && requestedDelivery !== "next-turn" && requestedDelivery !== "interrupt-replace") {
        throw invalid("delivery must be native-inject, next-turn or interrupt-replace");
      }
      delivery = requestedDelivery;
    }
    if (!this.deliveryMethods.includes(delivery)) {
      throw explicitReject(`delivery ${delivery} is not declared by this ACP instance`);
    }
    const inputId = identifier(params.inputId, "inputId");
    const clientRequestId = identifier(params.clientRequestId, "clientRequestId");
    if (this.inputs.has(inputId)) throw invalid("inputId is already registered");
    const record: InputRecord = {
      inputId,
      clientRequestId,
      targetNativeTurnId: active.nativeTurnId,
      allowedPaths: this.deliveryMethods,
      fallbackPolicy: "reject-unknown",
      requestedDelivery: delivery,
      accepted: false,
      queued: false,
      dispatched: false,
      terminal: false,
      nativeExecution: false,
      admission: { value: "none", version: 0 },
      delivery: { value: "none", version: 0 },
      evidence: { value: "none", version: 0 },
      withdrawal: { value: "none", version: 0 },
      outcome: "pending",
    };
    this.inputs.set(inputId, record);
    if (delivery === "native-inject") {
      const pending = [...this.inputs.values()].filter((candidate) =>
        candidate !== record && candidate.requestedDelivery === "native-inject"
        && candidate.admission.value === "none" && !candidate.terminal);
      if (pending.length > 0) {
        this.inputs.delete(inputId);
        throw explicitReject("an earlier native steer has no stable native input id and is still unsettled");
      }
      this.emitAccepted(record, active.nativeTurnId);
      record.nativeExecution = true;
      const attempt: NativeSteerAttempt = {
        inputId,
        text: input.text,
        settled: false,
        terminal: false,
      };
      active.steerAttempts.set(inputId, attempt);
      const response = this.connection!.request("session/prompt", {
        sessionId: this.newSession!.sessionId,
        prompt: toAcpPrompt(input, this.imagesAllowed),
      }, { timeoutMs: 0 });
      response.then(
        () => this.admitNativeSteer(record, attempt),
        (error: unknown) => this.rejectNativeSteer(record, attempt, error),
      );
      return { nativeTurnId: active.nativeTurnId, delivery, admission: "pending" };
    }
    if (delivery === "interrupt-replace") {
      if (active.replacement !== undefined) {
        this.inputs.delete(inputId);
        throw explicitReject("an interrupt replacement is already pending");
      }
      active.replacement = { record, input, delivery };
      try {
        this.connection!.notify("session/cancel", { sessionId: this.newSession!.sessionId });
      } catch (error) {
        active.replacement = undefined;
        record.terminal = true;
        record.admission = { value: "unknown", version: ++record.admission.version };
        record.outcome = "unknown";
        throw unknownOutcome(`ACP cancel could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
      record.queued = true;
      return { nativeTurnId: active.nativeTurnId, delivery, cancelling: true };
    }
    if (this.queue.length >= 16) {
      this.inputs.delete(inputId);
      throw explicitReject("the next-turn queue is full");
    }
    this.queue.push({ record, input, delivery });
    record.queued = true;
    return { nativeTurnId: active.nativeTurnId, delivery, queued: true };
  }

  private admitNativeSteer(record: InputRecord, attempt: NativeSteerAttempt): void {
    if (attempt.settled) return;
    attempt.settled = true;
    attempt.terminal = true;
    if (record.terminal) return;
    record.admission = { value: "accepted", version: ++record.admission.version };
    record.delivery = { value: "native-inject", version: ++record.delivery.version };
    record.evidence = { value: "evidence-observed", version: ++record.evidence.version, kind: "admission" };
    record.outcome = "delivered";
    void this.emit([
      {
        scope: { threadId: this.threadId },
        op: "input.delivery",
        inputId: record.inputId,
        deliveryMethod: "native-inject",
        admitted: true,
        version: record.delivery.version,
      },
      {
        scope: { threadId: this.threadId },
        op: "input.evidence",
        inputId: record.inputId,
        evidenceKind: "admission",
        version: record.evidence.version,
      },
    ]);
  }

  private rejectNativeSteer(record: InputRecord, attempt: NativeSteerAttempt, error: unknown): void {
    if (attempt.settled) return;
    attempt.settled = true;
    attempt.terminal = true;
    if (record.terminal) return;
    const rejected = error instanceof AcpRpcError
      && (error.code === -32602 || error.code === -32600 || /already in flight/i.test(error.message));
    const unknown = error instanceof AcpConnectionClosedError || /unconfirmed/i.test(String(error));
    record.terminal = true;
    record.admission = {
      value: rejected ? "rejected" : unknown ? "unknown" : "failed",
      version: record.admission.version + 1,
    };
    record.delivery = { value: "none", version: record.delivery.version + 1 };
    record.outcome = record.admission.value;
    void this.emit([
      {
        scope: { threadId: this.threadId },
        op: "input.delivery",
        inputId: record.inputId,
        deliveryMethod: "native-inject",
        admitted: false,
        version: record.delivery.version,
      },
      {
        scope: { threadId: this.threadId },
        op: "input.outcome",
        inputId: record.inputId,
        state: record.admission.value === "rejected" ? "rejected" : unknown ? "unknown" : "failed",
        reason: error instanceof Error ? error.message : String(error),
        version: record.admission.version,
      },
    ]);
  }

  private emitAccepted(record: InputRecord, nativeTurnId: string, disposition?: "steered" | "next-turn" | "interrupt-replace"): void {
    if (record.accepted) return;
    record.accepted = true;
    void this.emit([{
      scope: { threadId: this.threadId }, nativeTurnId,
      op: "input.accepted",
      inputId: record.inputId,
      clientRequestId: record.clientRequestId,
      expectedTurnId: nativeTurnId,
      targetNativeSession: this.newSession?.sessionId,
      allowedPaths: record.allowedPaths,
      fallbackPolicy: record.fallbackPolicy,
      ...(disposition === undefined ? {} : { disposition }),
    }]);
  }

  private parseInput(value: unknown): AcpPromptInput {
    try {
      return parsePromptInput(value, this.promptLimits());
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error));
    }
  }

  async stop(): Promise<Record<string, unknown>> {
    if (!this.opened || this.closed || this.agentExited) throw staleTarget("ACP session is not open");
    const active = this.active;
    if (active === null) {
      this.cancelPendingInteractions();
      this.clearQueue();
      return { cancelled: false };
    }
    try {
      this.connection!.notify("session/cancel", { sessionId: this.newSession!.sessionId });
    } catch (error) {
      throw unknownOutcome(`ACP cancel could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.cancelPendingInteractions();
    this.clearQueue();
    return { cancelled: true };
  }

  private cancelPendingInteractions(): void {
    for (const pending of this.pendingInteractions.values()) pending.resolve({ kind: "cancel" });
    this.pendingInteractions.clear();
  }

  private clearQueue(): number {
    let cleared = 0;
    for (const queued of this.queue.splice(0)) {
      queued.record.terminal = true;
      queued.record.queued = false;
      queued.record.withdrawal = { value: "withdrawn", version: ++queued.record.withdrawal.version };
      queued.record.outcome = "withdrawn";
      cleared += 1;
    }
    return cleared;
  }

  async withdraw(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const inputId = identifier(params.inputId, "inputId");
    const record = this.inputs.get(inputId);
    if (record === undefined) throw invalid("unknown inputId");
    if (record.terminal) return { state: record.withdrawal.value, outcome: record.outcome };
    const index = this.queue.findIndex((queued) => queued.record.inputId === inputId);
    if (index >= 0) {
      this.queue.splice(index, 1);
      record.terminal = true;
      record.queued = false;
      record.withdrawal = { value: "withdrawn", version: ++record.withdrawal.version };
      record.outcome = "withdrawn";
      return { state: "withdrawn", outcome: "withdrawn" };
    }
    record.withdrawal = { value: "too-late", version: ++record.withdrawal.version };
    record.outcome = "too-late";
    void this.emit([{
      scope: { threadId: this.threadId },
      op: "input.withdrawal",
      inputId,
      state: "too-late",
      version: record.withdrawal.version,
    }]);
    return { state: "too-late", outcome: "too-late" };
  }

  query(params: Record<string, unknown>): Record<string, unknown> {
    const filter = params.inputIds === undefined
      ? undefined
      : Array.isArray(params.inputIds) && params.inputIds.every((value) => typeof value === "string")
        ? new Set(params.inputIds as string[])
        : (() => { throw invalid("inputIds must be an array of strings"); })();
    const inputs = [...this.inputs.values()]
      .filter((record) => filter === undefined || filter.has(record.inputId))
      .map((record) => ({
        inputId: record.inputId,
        clientRequestId: record.clientRequestId,
        expectedTurnId: record.targetNativeTurnId,
        disposition: record.accepted
          ? record.requestedDelivery === "next-turn" || record.requestedDelivery === "interrupt-replace"
            ? record.requestedDelivery
            : "steered"
          : record.queued ? "queued" : null,
        nativeExecutions: record.nativeExecution ? 1 : 0,
        registration: record.accepted ? { value: "registered", version: 0 } : null,
        admission: record.admission,
        delivery: record.delivery,
        evidence: record.evidence,
        withdrawal: record.withdrawal,
        outcome: record.outcome,
      }));
    return { inputs };
  }

  async resolveInteraction(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const interactionId = identifier(params.interactionId, "interactionId");
    const result = object(params.result);
    if (this.resolvedInteractions.has(interactionId)) return { resolved: true, duplicate: true };
    const pending = this.pendingInteractions.get(interactionId);
    if (pending === undefined) throw staleTarget("unknown or already-resolved interaction");
    this.pendingInteractions.delete(interactionId);
    this.resolvedInteractions.add(interactionId);
    pending.resolve(resolvePermission(pending.options, result));
    return { resolved: true };
  }

  private async onAgentRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "session/request_permission") {
      return this.onPermissionRequest(params);
    }
    if (method === "elicitation/create") {
      return { action: "decline" };
    }
    if (method === "fs/read_text_file" || method === "fs/write_text_file"
      || method.startsWith("terminal/") || method === "mcp/connect" || method === "mcp/message") {
      throw new AcpRpcError(-32601, `the OpenCraft ACP bridge does not implement ${method}`);
    }
    const dialectResult = this.dialect.handleClientRequest?.(method, params);
    if (dialectResult !== undefined) return dialectResult;
    throw new AcpRpcError(-32601, `unsupported ACP client method ${method}`);
  }

  private async onPermissionRequest(params: Record<string, unknown>): Promise<unknown> {
    if (this.closing || this.closed || this.permissionPlan === null) {
      return { outcome: { outcome: "cancelled" } };
    }
    let request;
    try {
      request = parsePermissionRequest(params);
    } catch (error) {
      throw new AcpRpcError(-32602, error instanceof Error ? error.message : "invalid permission request");
    }
    if (request.sessionId !== this.newSession?.sessionId) {
      throw new AcpRpcError(-32602, "permission request for another session");
    }
    const auto = policyDecision(this.permissionPlan.approvalPolicy, request);
    if (auto === "allow" || auto === "deny") {
      const decision = chooseOption(request.options, auto);
      if (decision.kind === "option") return { outcome: { outcome: "selected", optionId: decision.optionId } };
    }
    if (this.pendingInteractions.size >= 32) {
      return { outcome: { outcome: "cancelled" } };
    }
    const interactionId = newInteractionId();
    const decisionPromise = new Promise<PermissionDecision>((resolve) => {
      this.pendingInteractions.set(interactionId, { options: request.options, resolve });
    });
    const payload = approvalPayload({
      threadId: this.threadId,
      interactionId,
      requested: request,
      mode: this.permissionPlan.requested,
      plan: this.permissionPlan,
      nativeTurnId: this.active?.nativeTurnId ?? null,
      cwd: this.cwd,
      startedAtMs: this.host.now(),
    });
    try {
      await this.host.callback("interaction/request", {
        threadId: this.threadId,
        interactionId,
        kind: "approval",
        payload,
        providerNativeIds: true,
      });
    } catch (error) {
      this.pendingInteractions.delete(interactionId);
      this.host.diagnostic(`permission interaction could not be delivered: ${String(error)}`);
      return { outcome: { outcome: "cancelled" } };
    }
    const decision = await decisionPromise;
    return decision.kind === "option"
      ? { outcome: { outcome: "selected", optionId: decision.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  private onAgentNotification(method: string, params: Record<string, unknown>): void {
    if (method !== "session/update") {
      this.host.diagnostic(`ignored ACP notification ${method}`);
      return;
    }
    if (params.sessionId !== this.newSession?.sessionId) return;
    const update = isRecord(params.update) ? params.update : undefined;
    if (update === undefined) {
      this.host.diagnostic("ACP session/update without an update object");
      return;
    }
    if (this.active === null) {
      const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
      if (kind === "available_commands_update" || kind === "current_mode_update"
        || kind === "config_option_update" || kind === "session_info_update") {
        const translator = new AcpDeltaTranslator({
          threadId: this.threadId,
          nativeTurnId: "acp-session",
          cwd: this.cwd,
        });
        void this.emit(translator.update(update));
        return;
      }
      if (kind === "usage_update") {
        void this.emit([{
          scope: { threadId: this.threadId },
          op: "contextWindow",
          usedTokens: typeof update.used === "number" ? update.used : 0,
          modelContextWindow: typeof update.size === "number" ? update.size : null,
        }]);
        return;
      }
      // A late chunk after the turn boundary cannot open a turn by itself.
      void this.emit([{
        scope: { threadId: this.threadId },
        op: "unhandled",
        reason: "ACP session/update arrived with no open turn",
        source: "session/update",
      }]);
      return;
    }
    const active = this.active;
    void this.emit(active.translator.update(update));
  }

  private onAgentExit(error: Error): void {
    if (this.closed) return;
    this.agentExited = true;
    const active = this.active;
    if (active !== null) {
      if (active.replacement !== undefined) {
        const record = active.replacement.record;
        record.terminal = true;
        record.queued = false;
        record.outcome = "unknown";
      }
      for (const attempt of active.steerAttempts.values()) {
        if (attempt.settled) continue;
        attempt.settled = true;
        attempt.terminal = true;
        const record = this.inputs.get(attempt.inputId);
        if (record !== undefined && !record.terminal) {
          record.terminal = true;
          record.admission = { value: "unknown", version: record.admission.version + 1 };
          record.outcome = "unknown";
          void this.emit([{
            scope: { threadId: this.threadId }, nativeTurnId: active.nativeTurnId,
            op: "input.outcome",
            inputId: record.inputId,
            state: "unknown",
            reason: `ACP agent exited: ${error.message}`,
            version: record.admission.version,
          }]);
        }
      }
      this.active = null;
      void this.emit(active.translator.finish("failed"));
      void this.emit([{
        scope: { threadId: this.threadId }, nativeTurnId: active.nativeTurnId,
        op: "provider.recovery",
        kind: "staleTurn",
        message: `ACP agent exited before the turn settled: ${error.message}. Do not resend the native prompt.`,
        retryable: false,
      }]);
    }
    for (const queued of this.queue.splice(0)) {
      queued.record.terminal = true;
      queued.record.queued = false;
      queued.record.outcome = "unknown";
    }
    for (const pending of this.pendingInteractions.values()) pending.resolve({ kind: "cancel" });
    this.pendingInteractions.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    this.cancelPendingInteractions();
    this.clearQueue();
    const active = this.active;
    if (active !== null) {
      try {
        this.connection?.notify("session/cancel", { sessionId: this.newSession?.sessionId });
      } catch { /* the connection may already be gone */ }
      await Promise.race([
        active.promptSettled.catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    this.closed = true;
    await this.emit([{
      scope: { threadId: this.threadId },
      op: "session.ended",
      reason: "ACP bridge session closed",
    }]).catch(() => {});
    await this.connection?.close().catch(() => {});
  }

  async abort(): Promise<void> {
    this.closed = true;
    for (const pending of this.pendingInteractions.values()) pending.resolve({ kind: "cancel" });
    this.pendingInteractions.clear();
    await this.connection?.close().catch(() => {});
  }
}

export class AcpBridge {
  readonly declaration: BridgeDeclaration;
  private readonly dialect: AcpDialect;
  private readonly sessions = new Map<string, AcpSession>();
  private effective: DeclaredCapabilities | null = null;
  private probe: AcpInitializeResult | null = null;
  private closed = false;

  constructor(private readonly options: AcpBridgeOptions) {
    this.declaration = declarationFor(options.profile);
    this.dialect = resolveAcpDialect(options.profile.dialect);
  }

  now(): number {
    return this.options.now?.() ?? Date.now();
  }

  diagnostic(line: string): void {
    this.options.onDiagnostic?.(line);
  }

  traceFrame(direction: "in" | "out", frame: unknown): void {
    this.options.onFrame?.(direction, frame);
  }

  async initialize(params: Record<string, unknown>): Promise<BridgeInitializeResult> {
    if (this.closed) throw unsupported("bridge is closing");
    if (this.effective !== null) throw invalid("initialize was already negotiated");
    const protocolVersion = params.protocolVersion;
    const grammarRange = params.grammarRange;
    if (typeof protocolVersion !== "number" || !isRecord(grammarRange)
      || typeof grammarRange.min !== "number" || typeof grammarRange.max !== "number") {
      throw invalid("initialize needs protocolVersion and grammarRange");
    }
    const negotiation = negotiateHandshake({
      protocolVersion,
      grammarRange: { min: grammarRange.min, max: grammarRange.max },
    }, this.declaration);
    if (!negotiation.ok) {
      throw new BridgeCommandError("unsupported", BRIDGE_ERROR_CODES.unsupportedCapability, negotiation.error.message);
    }
    const probe = await this.probeAgent();
    this.probe = probe;
    const capabilities = this.narrow(probe);
    this.effective = capabilities;
    return {
      protocolVersion: negotiation.result.protocolVersion,
      grammarVersion: negotiation.result.grammarVersion,
      approvalExecutor: this.declaration.approvalExecutor,
      effectiveCapabilities: capabilities,
    };
  }

  private narrow(initialize: AcpInitializeResult): DeclaredCapabilities {
    const declared = this.declaration.capabilities;
    const native = this.dialect.nativeSteering({ initialize, session: { sessionId: "probe" } });
    const images = initialize.agentCapabilities?.promptCapabilities?.image === true;
    const deliveryMethods = declared.steer.deliveryMethods.filter((method) =>
      method !== "native-inject" || native);
    const contentTypes = images
      ? declared.inputContentTypes
      : declared.inputContentTypes.filter((type) => type !== "image");
    return {
      ...declared,
      inputContentTypes: contentTypes,
      steer: {
        ...declared.steer,
        deliveryMethods,
        contentLimits: {
          maxBytes: declared.steer.contentLimits.maxBytes,
          allowedContentTypes: images
            ? declared.steer.contentLimits.allowedContentTypes
            : declared.steer.contentLimits.allowedContentTypes.filter((type) => type !== "image"),
        },
      },
    };
  }

  private async probeAgent(): Promise<AcpInitializeResult> {
    const connection = new AcpConnection({
      command: this.options.profile.agent.command,
      args: this.options.profile.agent.args,
      cwd: this.options.profile.agent.cwd,
      ...(this.options.profile.agent.env === undefined ? {} : { env: this.options.profile.agent.env }),
      onRequest: (method) => {
        throw new AcpRpcError(-32601, `bridge capability probe does not answer ${method}`);
      },
      onNotification: () => {},
      onDiagnostic: (line) => this.diagnostic(`acp-probe(${this.options.profile.providerId}) ${line}`),
      onFrame: (direction, frame) => this.traceFrame(direction, frame),
      requestTimeoutMs: 20_000,
    });
    try {
      connection.spawn();
      return await connection.initialize();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind: BridgeErrorKind = /auth|login|credential|token/i.test(message) ? "auth" : "internal";
      const code = kind === "auth" ? BRIDGE_ERROR_CODES.auth : BRIDGE_ERROR_CODES.internal;
      throw new BridgeCommandError(kind, code, `ACP initialize probe failed: ${message}`);
    } finally {
      await connection.close().catch(() => {});
    }
  }

  async callback(method: CallbackMethod, params: Record<string, unknown>): Promise<unknown> {
    return this.options.requestCallback(method, params);
  }

  async emitDeltas(threadId: string, deltas: readonly BridgeDelta[]): Promise<void> {
    if (deltas.length === 0) return;
    await this.options.requestCallback("thread/delta", { threadId, deltas: [...deltas] });
  }

  async handle(method: string, rawParams: unknown): Promise<unknown> {
    if (this.closed) throw unsupported("bridge is closing");
    const params = object(rawParams);
    if (method === "initialize") return this.initialize(params);
    if (this.effective === null) throw unsupported("initialize must succeed before commands");
    switch (method) {
      case "session/create": {
        const threadId = identifier(params.threadId, "threadId");
        if (this.sessions.has(threadId)) throw invalid("thread already has an ACP session");
        const session = new AcpSession(this, threadId, this.options.profile, this.dialect, this.effective);
        this.sessions.set(threadId, session);
        try {
          return await session.open(params);
        } catch (error) {
          this.sessions.delete(threadId);
          await session.abort().catch(() => {});
          throw error;
        }
      }
      case "session/resume":
        throw unsupported("ACP session resume is not implemented in P3");
      case "session/close": {
        const threadId = identifier(params.threadId, "threadId");
        const session = this.sessions.get(threadId);
        if (session === undefined) return { closed: true, duplicate: true };
        await session.close();
        this.sessions.delete(threadId);
        return { closed: true };
      }
      case "turn/start": {
        const session = this.requireSession(params);
        return session.startTurn(params);
      }
      case "turn/steer": {
        const session = this.requireSession(params);
        return session.steer(params);
      }
      case "turn/stop": {
        const session = this.requireSession(params);
        return session.stop();
      }
      case "input/query": {
        const session = this.requireSession(params);
        return session.query(params);
      }
      case "input/withdraw": {
        const session = this.requireSession(params);
        return session.withdraw(params);
      }
      case "interaction/resolve": {
        const session = this.requireSession(params);
        return session.resolveInteraction(params);
      }
      case "maintenance/probe":
        return {
          providerId: this.options.profile.providerId,
          dialect: this.options.profile.dialect,
          agent: this.options.profile.agent.command,
          initialize: this.probe,
          effectiveCapabilities: this.effective,
        };
      case "model/list":
      case "history/read":
      case "skills/configure":
      case "installation/status":
      case "installation/run":
        throw unsupported(`${method} is not declared by the ACP bridge`);
      default:
        throw unsupported(`unsupported bridge method ${method}`);
    }
  }

  private requireSession(params: Record<string, unknown>): AcpSession {
    const threadId = identifier(params.threadId, "threadId");
    const session = this.sessions.get(threadId);
    if (session === undefined) throw staleTarget("unknown ACP session");
    return session;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
  }
}
