import { randomUUID } from "node:crypto";
import type {
  BridgeDelta,
  DeliveryMethod,
  ItemShape,
  TokenUsage,
  TurnStatus,
} from "@opencraft/agent-bridge-protocol";
import { BridgeCommandError, authRequired, explicitReject, invalid, staleTarget, unknownOutcome, unsupported } from "./errors.js";
import type {
  ModelRow,
  NativeInitInfo,
  NativeSessionPort,
  NativeStartOptions,
  PermissionModeName,
} from "./types.js";
import { isRecord, numberField, stringArray, stringField } from "./types.js";

export interface SessionInfo {
  readonly providerThreadId: string;
  readonly nativeVersion: string;
  readonly model: string;
  readonly permissionMode: string | null;
  readonly models: readonly ModelRow[];
  readonly pid: number | null;
}

export interface StartTurnInput {
  readonly inputId: string;
  readonly clientRequestId: string;
  readonly text: string;
  readonly model?: string;
  readonly permissionMode?: PermissionModeName;
}

export interface SteerInput {
  readonly inputId: string;
  readonly clientRequestId: string;
  readonly text: string;
  readonly expectedTurnId?: string;
  readonly deliveryMethod?: DeliveryMethod;
}

export interface InputStatus {
  readonly inputId: string;
  readonly clientRequestId: string;
  readonly nativeInputId: string;
  readonly expectedTurnId: string | null;
  readonly deliveryMethod: DeliveryMethod | null;
  readonly admitted: boolean;
  readonly evidence: "none" | "evidence-observed" | "context-confirmed";
  readonly evidenceRef: string | null;
  readonly runId: string | null;
  readonly withdrawal: "none" | "withdraw-requested" | "withdrawn" | "too-late" | "unsupported" | "unknown";
  readonly outcome:
    | "pending"
    | "registered"
    | "queued"
    | "delivered"
    | "context-confirmed"
    | "evidence-observed"
    | "withdrawn"
    | "too-late"
    | "rejected"
    | "failed"
    | "unknown";
  readonly version: number;
}

interface InputRecord {
  readonly inputId: string;
  readonly clientRequestId: string;
  readonly uuid: string;
  readonly text: string;
  nativeTurnId: string | null;
  deliveryMethod: DeliveryMethod | null;
  admitted: boolean;
  evidence: "none" | "evidence-observed" | "context-confirmed";
  evidenceRef: string | null;
  runId: string | null;
  withdrawal: "none" | "withdraw-requested" | "withdrawn" | "too-late" | "unsupported" | "unknown";
  outcome: InputStatus["outcome"];
  version: number;
}

interface ActiveTurn {
  readonly nativeTurnId: string;
  resultSeen: boolean;
  resultStatus: TurnStatus;
  resultsSinceSteer: number;
  pending: Set<string>;
  background: Set<string>;
  backgroundWasLive: boolean;
  idleSeen: boolean;
  mainRun: "running" | "idle";
  queuedTurns: number;
}

export interface ClaudeSessionOptions {
  /** Host route identity; every delta and callback uses this exact scope. */
  readonly scopeId: string;
  readonly cwd: string;
  readonly model?: string;
  readonly permissionMode?: PermissionModeName;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly maxTurns?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly systemPromptAppend?: string;
  readonly emit: (deltas: readonly BridgeDelta[]) => Promise<void>;
  readonly emitIdentity: (info: { providerThreadId: string; sessionRestorable: boolean }) => Promise<void>;
  /** Safety valve for a steer that was admitted but produced no result. */
  readonly steerWaitTimeoutMs?: number;
  /** Grace after background work drains but before the idle signal. */
  readonly backgroundIdleGraceMs?: number;
  /** Safety valve for a turn held by queued native work or stale background state. */
  readonly maxHoldMs?: number;
  readonly pushTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
}

const DEFAULT_STEER_WAIT_MS = 120_000;
const DEFAULT_IDLE_GRACE_MS = 2_000;
const DEFAULT_MAX_HOLD_MS = 10 * 60_000;
const DEFAULT_INIT_MS = 30_000;
const DEFAULT_PUSH_MS = 15_000;

/** Serialize commands and native messages so races resolve by arrival order. */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  drain(): Promise<unknown> {
    return this.tail;
  }
}

function messageType(value: unknown): string | undefined {
  return isRecord(value) && typeof value.type === "string" ? value.type : undefined;
}

function messageSubtype(value: unknown): string | undefined {
  return isRecord(value) && typeof value.subtype === "string" ? value.subtype : undefined;
}

function contentBlocks(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || !isRecord(value.message)) return [];
  const content = value.message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

const MAX_ITEM_TEXT_BYTES = 256 * 1024;

/** SDK informational frames that do not map to canonical timeline facts here. */
const IGNORED_MESSAGE_TYPES = new Set([
  "api_retry",
  "commands_changed",
  "control_request_progress",
  "conversation_reset",
  "elicitation_complete",
  "files_persisted",
  "hook_progress",
  "hook_response",
  "hook_started",
  "informational",
  "local_command_output",
  "memory_recall",
  "mirror_error",
  "notification",
  "permission_denied",
  "plugin_install",
  "prompt_suggestion",
  "task_progress",
  "thinking_tokens",
  "tool_use_summary",
  "worker_shutting_down",
]);

function boundedText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_ITEM_TEXT_BYTES) return text;
  const decoded = Buffer.from(text, "utf8").subarray(0, MAX_ITEM_TEXT_BYTES).toString("utf8");
  return `${decoded.replace(/\uFFFD$/u, "")}\n…[truncated by Claude bridge]`;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
}

function resultUuids(value: unknown): { present: boolean; uuids: string[] } {
  if (!isRecord(value)) return { present: false, uuids: [] };
  const many = stringArray(value.user_message_uuids);
  if (many !== undefined) return { present: true, uuids: many };
  if (typeof value.user_message_uuid === "string") return { present: true, uuids: [value.user_message_uuid] };
  return { present: false, uuids: [] };
}

function zeroUsage(): TokenUsage {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function usageFrom(value: unknown): TokenUsage {
  if (!isRecord(value)) return zeroUsage();
  const input = numberField(value, "input_tokens") ?? 0;
  const output = numberField(value, "output_tokens") ?? 0;
  const cached = numberField(value, "cache_read_input_tokens") ?? 0;
  const cacheWrite = numberField(value, "cache_creation_input_tokens") ?? 0;
  const reasoning = numberField(value, "thinking_tokens") ?? 0;
  return {
    totalTokens: input + output + cached + cacheWrite,
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
  };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    totalTokens: left.totalTokens + right.totalTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteInputTokens: left.cacheWriteInputTokens + right.cacheWriteInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
  };
}

function usageOfResult(value: unknown): { total: TokenUsage; last: TokenUsage; modelContextWindow: number | null } | null {
  if (!isRecord(value)) return null;
  const last = usageFrom(value.usage);
  let total = zeroUsage();
  let window: number | null = null;
  if (isRecord(value.modelUsage)) {
    for (const entry of Object.values(value.modelUsage)) {
      if (!isRecord(entry)) continue;
      total = addUsage(total, {
        totalTokens: 0,
        inputTokens: numberField(entry, "inputTokens") ?? 0,
        cachedInputTokens: numberField(entry, "cacheReadInputTokens") ?? 0,
        cacheWriteInputTokens: numberField(entry, "cacheCreationInputTokens") ?? 0,
        outputTokens: numberField(entry, "outputTokens") ?? 0,
        reasoningOutputTokens: numberField(entry, "thinkingTokens") ?? 0,
      });
      const entryWindow = numberField(entry, "contextWindow");
      if (entryWindow !== undefined) window = Math.max(window ?? 0, entryWindow);
    }
  }
  if (total.totalTokens === 0) total = last;
  else total = {
    ...total,
    totalTokens: total.inputTokens + total.cachedInputTokens + total.cacheWriteInputTokens + total.outputTokens,
  };
  return { total, last, modelContextWindow: window };
}

function resultStatus(value: unknown): TurnStatus {
  if (!isRecord(value)) return "failed";
  if (value.subtype === "success") return value.is_error === true ? "failed" : "completed";
  const reason = stringField(value, "terminal_reason");
  if (reason === "aborted_streaming" || reason === "aborted_tools") return "interrupted";
  return "failed";
}

/**
 * One Claude SDK session. Every command and SDK message goes through one
 * serial queue, so a steer that arrives before the result is admitted and held;
 * a steer that arrives after the turn settled is an explicit stale rejection.
 */
export class ClaudeSession {
  private readonly queue = new SerialQueue();
  private readonly inputs = new Map<string, InputRecord>();
  private readonly tools = new Map<string, { name: string; shape: ItemShape }>();
  private native?: NativeSessionPort;
  private info?: SessionInfo;
  private active?: ActiveTurn;
  private closed = false;
  private pumpStarted = false;
  private turnSequence = 0;
  private steerTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private holdTimer?: ReturnType<typeof setTimeout>;
  private uuidSupport: boolean | undefined;
  private warnedOutsideTurn = false;

  constructor(
    private readonly options: ClaudeSessionOptions,
    private readonly factory: { start(options: NativeStartOptions): NativeSessionPort },
  ) {}

  get scopeId(): string {
    return this.options.scopeId;
  }

  get sessionInfo(): SessionInfo | undefined {
    return this.info;
  }

  create(): Promise<SessionInfo> {
    return this.queue.run(async () => {
      if (this.closed) throw staleTarget("Session is closed");
      if (this.info !== undefined) return this.info;
      const sessionId = randomUUID();
      const native = this.factory.start({
        cwd: this.options.cwd,
        sessionId,
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.permissionMode ? { permissionMode: this.options.permissionMode } : {}),
        ...(this.options.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
        ...(this.options.allowedTools ? { allowedTools: this.options.allowedTools } : {}),
        ...(this.options.disallowedTools ? { disallowedTools: this.options.disallowedTools } : {}),
        ...(this.options.maxTurns !== undefined ? { maxTurns: this.options.maxTurns } : {}),
        ...(this.options.env ? { env: this.options.env } : {}),
        ...(this.options.systemPromptAppend ? { systemPromptAppend: this.options.systemPromptAppend } : {}),
      });
      this.native = native;
      this.startPump();
      let init: NativeInitInfo;
      try {
        init = await this.withTimeout(native.initialize(), this.options.initializeTimeoutMs ?? DEFAULT_INIT_MS, "Claude SDK initialization");
      } catch (error) {
        await native.close().catch(() => {});
        this.native = undefined;
        this.closed = true;
        const message = error instanceof Error ? error.message : String(error);
        if (/auth|login|credential|token/i.test(message)) throw authRequired(`Claude Code authentication failed: ${message}`);
        throw new BridgeCommandError("internal", -32603, `Claude SDK did not initialize: ${message}`);
      }
      this.info = {
        providerThreadId: init.sessionId,
        nativeVersion: init.version,
        model: init.model,
        permissionMode: init.permissionMode,
        models: init.models,
        pid: init.pid,
      };
      try {
        await this.options.emitIdentity({ providerThreadId: init.sessionId, sessionRestorable: false });
      } catch (error) {
        await native.close().catch(() => {});
        this.native = undefined;
        this.closed = true;
        throw error;
      }
      return this.info;
    });
  }

  startTurn(input: StartTurnInput): Promise<Record<string, unknown>> {
    return this.queue.run(async () => {
      this.requireOpen();
      const text = this.validateText(input.text);
      const inputId = this.validateId(input.inputId, "inputId");
      const clientRequestId = this.validateId(input.clientRequestId, "clientRequestId");
      const existing = this.inputs.get(inputId);
      if (existing !== undefined) {
        if (existing.clientRequestId === clientRequestId && existing.text === text) {
          return { ...this.statusOf(existing), idempotent: true };
        }
        throw explicitReject("inputId was already used with different content", { inputId });
      }
      if (this.active !== undefined) throw staleTarget("A Claude turn is already active");
      if (input.model !== undefined && input.model !== this.info?.model) {
        if (this.native?.setModel === undefined) throw unsupported("The native session cannot switch models");
        try {
          await this.native.setModel(input.model);
        } catch (error) {
          throw explicitReject(`Claude model switch was refused: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.info = { ...this.info!, model: input.model };
      }
      if (input.permissionMode !== undefined && input.permissionMode !== this.info?.permissionMode) {
        if (input.permissionMode === "bypassPermissions" && this.options.allowDangerouslySkipPermissions !== true) {
          throw explicitReject("bypassPermissions requires allowDangerouslySkipPermissions at session/create");
        }
        if (this.native?.setPermissionMode === undefined) throw unsupported("The native session cannot switch permission modes");
        try {
          await this.native.setPermissionMode(input.permissionMode);
        } catch (error) {
          throw explicitReject(`Claude permission-mode switch was refused: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.info = { ...this.info!, permissionMode: input.permissionMode };
      }
      const nativeTurnId = `ct${++this.turnSequence}`;
      const record = this.registerInput({ inputId, clientRequestId, text, nativeTurnId });
      this.active = {
        nativeTurnId,
        resultSeen: false,
        resultStatus: "completed",
        resultsSinceSteer: 0,
        pending: new Set(),
        background: new Set(),
        backgroundWasLive: false,
        idleSeen: false,
        mainRun: "running",
        queuedTurns: 0,
      };
      await this.emit([
        {
          op: "input.accepted",
          scope: this.scope(),
          inputId,
          clientRequestId,
          expectedTurnId: nativeTurnId,
          targetNativeSession: this.info!.providerThreadId,
          allowedPaths: ["native-inject"],
          fallbackPolicy: "reject-unknown",
        },
        { op: "turn.open", scope: this.scope(), nativeTurnId },
        { op: "turn.mainRun", scope: this.scope(), state: "running" },
      ]);
      try {
        await this.withTimeout(
          this.native!.push(text, record.uuid),
          this.options.pushTimeoutMs ?? DEFAULT_PUSH_MS,
          "Claude SDK input admission",
        );
      } catch (error) {
        this.native?.failInput(error instanceof Error ? error : new Error(String(error)));
        record.outcome = "unknown";
        record.version += 1;
        await this.emit([
          {
            op: "input.outcome",
            scope: this.scope(),
            inputId,
            state: "unknown",
            reason: error instanceof Error ? error.message : String(error),
            version: record.version,
          },
        ]);
        await this.closeTurn("failed");
        await this.native?.close().catch(() => {});
        throw unknownOutcome(
          `Claude SDK input admission is unknown: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await this.emitAdmission(record);
      return {
        inputId,
        clientRequestId,
        nativeTurnId,
        nativeInputId: record.uuid,
        deliveryMethod: "native-inject",
        admitted: true,
        pid: this.info!.pid,
      };
    });
  }

  steer(input: SteerInput): Promise<Record<string, unknown>> {
    return this.queue.run(async () => {
      this.requireOpen();
      const active = this.active;
      if (active === undefined) throw staleTarget("No active Claude turn to steer");
      if (input.expectedTurnId !== undefined && input.expectedTurnId !== active.nativeTurnId) {
        throw staleTarget(`Expected turn ${input.expectedTurnId} is no longer active`, {
          activeTurnId: active.nativeTurnId,
        });
      }
      if (input.deliveryMethod !== undefined && input.deliveryMethod !== "native-inject") {
        throw unsupported(`Claude bridge only supports native-inject, not ${input.deliveryMethod}`);
      }
      const text = this.validateText(input.text);
      const inputId = this.validateId(input.inputId, "inputId");
      const clientRequestId = this.validateId(input.clientRequestId, "clientRequestId");
      const existing = this.inputs.get(inputId);
      if (existing !== undefined) {
        if (existing.clientRequestId === clientRequestId && existing.text === text) {
          return { ...this.statusOf(existing), idempotent: true };
        }
        throw explicitReject("inputId was already used with different content", { inputId });
      }
      const record = this.registerInput({ inputId, clientRequestId, text, nativeTurnId: active.nativeTurnId });
      active.pending.add(inputId);
      active.resultsSinceSteer = 0;
      active.idleSeen = false;
      this.clearHoldTimer();
      await this.emit([
        {
          op: "input.accepted",
          scope: this.scope(),
          inputId,
          clientRequestId,
          expectedTurnId: active.nativeTurnId,
          targetNativeSession: this.info!.providerThreadId,
          allowedPaths: ["native-inject"],
          fallbackPolicy: "reject-unknown",
        },
      ]);
      try {
        await this.withTimeout(
          this.native!.push(text, record.uuid),
          this.options.pushTimeoutMs ?? DEFAULT_PUSH_MS,
          "Claude SDK steer admission",
        );
      } catch (error) {
        this.native?.failInput(error instanceof Error ? error : new Error(String(error)));
        active.pending.delete(inputId);
        record.outcome = "unknown";
        record.version += 1;
        await this.emit([
          {
            op: "input.outcome",
            scope: this.scope(),
            inputId,
            state: "unknown",
            reason: error instanceof Error ? error.message : String(error),
            version: record.version,
          },
        ]);
        await this.closeTurn("failed");
        await this.native?.close().catch(() => {});
        throw unknownOutcome(
          `Claude SDK steer admission is unknown: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await this.emitAdmission(record);
      await this.maybeSettle();
      this.armHoldTimer(active);
      return {
        inputId,
        clientRequestId,
        nativeTurnId: active.nativeTurnId,
        nativeInputId: record.uuid,
        deliveryMethod: "native-inject",
        admitted: true,
      };
    });
  }

  stop(): Promise<Record<string, unknown>> {
    return this.queue.run(async () => {
      this.requireOpen();
      const active = this.active;
      if (active === undefined) return { interrupted: false };
      let receipt;
      try {
        receipt = await this.native!.interrupt();
      } catch (error) {
        throw unknownOutcome(`Claude interrupt outcome is unknown: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (active.pending.size > 0) {
        const stillQueued = new Set(receipt.stillQueued);
        const cancelled = new Set(receipt.cancelled);
        for (const inputId of [...active.pending]) {
          const record = this.inputs.get(inputId);
          if (record === undefined || record.evidence === "context-confirmed") continue;
          const wasCancelled = cancelled.has(record.uuid);
          record.outcome = wasCancelled ? "failed" : "unknown";
          record.version += 1;
          await this.emit([{
            op: "input.outcome",
            scope: this.scope(),
            inputId,
            state: wasCancelled ? "failed" : "unknown",
            reason: wasCancelled
              ? "Native stop cancelled the queued steer before it ran"
              : stillQueued.has(record.uuid)
                ? "Native stop interrupted the turn; the queued steer may still run"
                : "Native stop interrupted the turn before the steer was confirmed",
            version: record.version,
          }]);
        }
        active.pending.clear();
      }
      if (active.mainRun !== "idle") {
        active.mainRun = "idle";
        await this.emit([{ op: "turn.mainRun", scope: this.scope(), state: "idle" }]);
      }
      await this.closeTurn("interrupted");
      return { interrupted: true };
    });
  }

  query(inputIds?: readonly string[]): InputStatus[] {
    const ids = inputIds === undefined ? [...this.inputs.keys()] : inputIds;
    return ids
      .map((id) => this.inputs.get(id))
      .filter((record): record is InputRecord => record !== undefined)
      .map((record) => this.statusOf(record));
  }

  withdraw(inputId: string): Promise<Record<string, unknown>> {
    return this.queue.run(async () => {
      this.requireOpen();
      const record = this.inputs.get(inputId);
      if (record === undefined) return { inputId, state: "unknown" };
      // The SDK input stream owns the message as soon as the iterable takes
      // it; this bridge never holds a pre-dispatch queue of its own, so the
      // honest capability is `none` rather than a fake withdrawal window.
      await this.setWithdrawal(record, "unsupported");
      return { inputId, state: "unsupported" };
    });
  }

  models(): readonly ModelRow[] {
    return this.info?.models ?? [];
  }

  /** Test/maintenance barrier: resolves after all queued commands and messages. */
  drain(): Promise<void> {
    return this.queue.drain().then(() => undefined);
  }

  async close(): Promise<void> {
    await this.queue.run(async () => {
      if (this.closed) return;
      this.closed = true;
      this.clearTimers();
      await this.settleUnconfirmed("Bridge session closed before the steer was confirmed").catch(() => {});
      if (this.active !== undefined) await this.closeTurn("interrupted").catch(() => {});
      await this.native?.close().catch(() => {});
      this.native = undefined;
      try {
        await this.emit([{ op: "session.ended", scope: this.scope(), reason: "bridge session closed" }]);
      } catch {
        // The Host may already be gone; there is no second delivery channel.
      }
    });
  }

  private startPump(): void {
    if (this.pumpStarted) return;
    this.pumpStarted = true;
    void (async () => {
      try {
        for await (const message of this.native!.messages) {
          await this.queue.run(() => this.handleMessage(message));
        }
        this.native?.failInput(new Error("Claude SDK message stream ended"));
        await this.queue.run(() => this.handleNativeEnd(undefined));
      } catch (error) {
        // Close the input transport before queueing settlement: a command may
        // be awaiting native.push and would otherwise keep this queue blocked
        // forever, including session/close and handleNativeEnd itself.
        this.native?.failInput(error instanceof Error ? error : new Error(String(error)));
        await this.queue.run(() => this.handleNativeEnd(error));
      }
    })();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (this.closed) return;
    const type = messageType(message);
    if (type === undefined) return;
    if (type === "system") {
      const subtype = messageSubtype(message);
      switch (subtype) {
        case "init": {
          if (isRecord(message) && this.info !== undefined) {
            const model = stringField(message, "model");
            const permissionMode = stringField(message, "permissionMode");
            if (model !== undefined || permissionMode !== undefined) {
              this.info = {
                ...this.info,
                ...(model !== undefined ? { model } : {}),
                ...(permissionMode !== undefined ? { permissionMode } : {}),
              };
            }
          }
          return;
        }
        case "background_tasks_changed": {
          if (!isRecord(message) || !Array.isArray(message.tasks)) return;
          const active = this.active;
          if (active === undefined) return;
          const tasks = message.tasks
            .filter(isRecord)
            .filter((task) => task.ambient !== true)
            .map((task) => stringField(task, "task_id"))
            .filter((id): id is string => id !== undefined);
          active.background = new Set(tasks);
          if (tasks.length > 0) {
            active.backgroundWasLive = true;
            active.idleSeen = false;
          }
          this.clearIdleTimer();
          await this.maybeSettle();
          return;
        }
        case "task_started": {
          const active = this.active;
          const id = isRecord(message) ? stringField(message, "task_id") : undefined;
          const backgrounded = isRecord(message) && message.is_backgrounded === true;
          const ambient = isRecord(message) && message.skip_transcript === true;
          if (active !== undefined && id !== undefined && backgrounded && !ambient) {
            active.background.add(id);
            active.backgroundWasLive = true;
          }
          return;
        }
        case "task_notification":
        case "task_updated": {
          const active = this.active;
          const id = isRecord(message) ? stringField(message, "task_id") : undefined;
          if (active !== undefined && id !== undefined) {
            const patch = isRecord(message) && isRecord(message.patch) ? message.patch : undefined;
            const status = patch !== undefined ? stringField(patch, "status") : undefined;
            if (subtype === "task_notification" || patch?.is_backgrounded === false
              || status === "completed" || status === "failed" || status === "killed") {
              active.background.delete(id);
            }
          }
          await this.maybeSettle();
          return;
        }
        case "session_state_changed": {
          const active = this.active;
          if (active === undefined || !isRecord(message)) return;
          if (message.state === "idle") {
            active.idleSeen = true;
            active.background.clear();
            active.backgroundWasLive = false;
            if (active.mainRun !== "idle") {
              active.mainRun = "idle";
              await this.emit([{ op: "turn.mainRun", scope: this.scope(), state: "idle" }]);
            }
            await this.maybeSettle();
          } else if (message.state === "running") {
            active.idleSeen = false;
            this.clearIdleTimer();
            if (active.mainRun !== "running") {
              // A new native run may start without an assistant frame first (for
              // example a queued steer); do not let the previous result settle
              // the logical turn while this run is live.
              active.mainRun = "running";
              active.resultSeen = false;
              await this.emit([{ op: "turn.mainRun", scope: this.scope(), state: "running" }]);
            }
            this.clearHoldTimer();
            this.armHoldTimer(active);
            if (active.pending.size > 0 || active.queuedTurns > 0) this.armSteerTimer(active);
          }
          return;
        }
        case "status": {
          if (!isRecord(message)) return;
          const status = stringField(message, "status");
          if (status !== undefined) {
            await this.emit([
              { op: "extension.state", scope: this.scope(), extensionKind: "claude.status", state: status },
            ]);
          }
          return;
        }
        case "auth_status": {
          if (isRecord(message) && typeof message.error === "string" && message.error.length > 0) {
            await this.emit([
              {
                op: "provider.recovery",
                scope: this.scope(),
                kind: "authRequired",
                message: message.error,
                retryable: true,
              },
            ]);
          }
          return;
        }
        default:
          return;
      }
    }
    if (type === "assistant") {
      await this.handleAssistant(message);
      return;
    }
    if (type === "user") {
      await this.handleUser(message);
      return;
    }
    if (type === "result") {
      await this.handleResult(message);
      return;
    }
    if (type === "tool_progress") {
      const active = this.active;
      const key = isRecord(message) ? stringField(message, "tool_use_id") : undefined;
      if (active !== undefined && key !== undefined) {
        await this.emit([{ op: "item.progress", scope: this.scope(), nativeKey: key }]);
      }
      return;
    }
    if (type === "stream_event") return;
    if (type === "auth_status") {
      if (isRecord(message) && typeof message.error === "string" && message.error.length > 0) {
        await this.emit([
          { op: "provider.recovery", scope: this.scope(), kind: "authRequired", message: message.error, retryable: true },
        ]);
      }
      return;
    }
    if (type === "rate_limit_event") {
      const info = isRecord(message) && isRecord(message.rate_limit_info) ? message.rate_limit_info : undefined;
      const status = info !== undefined ? stringField(info, "status") : undefined;
      if (status === "rejected" || status === "allowed_warning") {
        const reset = info !== undefined ? numberField(info, "resetsAt") : undefined;
        await this.emit([{
          op: "provider.recovery",
          scope: this.scope(),
          kind: "rateLimited",
          message: reset !== undefined
            ? `Claude rate limit ${status}; resetsAt=${reset}`
            : `Claude rate limit ${status}`,
          retryable: true,
        }]);
      }
      return;
    }
    if (IGNORED_MESSAGE_TYPES.has(type)) return;
    await this.warnOutsideTurn(`unsupported Claude SDK message type ${type}`);
  }

  private async handleAssistant(message: unknown): Promise<void> {
    const active = this.active;
    if (active === undefined) {
      await this.warnOutsideTurn("assistant message arrived with no open turn");
      return;
    }
    const parentToolUseId = isRecord(message) ? stringField(message, "parent_tool_use_id") : undefined;
    if (parentToolUseId === undefined) {
      this.clearTimers();
      active.idleSeen = false;
      if (active.mainRun !== "running") {
        // A follow-up run (for example after a queued steer) gets its own
        // result; the previous result must not let this message settle the
        // held turn. Subagent frames do not start a main run.
        active.resultSeen = false;
        active.mainRun = "running";
        await this.emit([{ op: "turn.mainRun", scope: this.scope(), state: "running" }]);
      }
    }
    const uuids = resultUuids(message);
    if (uuids.present) {
      this.uuidSupport = true;
      await this.consumeEvidence(uuids.uuids, isRecord(message) ? stringField(message, "uuid") : undefined);
    }
    const parentRef = parentToolUseId !== undefined ? { parentRef: parentToolUseId } : {};
    const messageUuid = isRecord(message) ? stringField(message, "uuid") ?? "assistant" : "assistant";
    const blocks = contentBlocks(message);
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      if (block.type === "text" && typeof block.text === "string" && parentToolUseId === undefined) {
        await this.emitTextItem(`${messageUuid}:text:${index}`, "agentMessage", boundedText(block.text), parentRef);
      } else if (block.type === "thinking" && typeof block.thinking === "string" && parentToolUseId === undefined) {
        await this.emitTextItem(`${messageUuid}:thinking:${index}`, "reasoning", boundedText(block.thinking), parentRef);
      } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        await this.openTool(block.id, block.name, isRecord(block.input) ? block.input : {}, parentRef);
      }
    }
    if (parentToolUseId === undefined) {
      await this.maybeSettle();
      if (this.active === active) this.armHoldTimer(active);
    }
  }

  private async handleUser(message: unknown): Promise<void> {
    const record = isRecord(message) ? message : undefined;
    if (record === undefined) return;
    let startedNewRun = false;
    if (record.isReplay === true && typeof record.uuid === "string") {
      this.uuidSupport = true;
      const active = this.active;
      const pendingReplay = active !== undefined && [...active.pending].some(
        (inputId) => this.inputs.get(inputId)?.uuid === record.uuid,
      );
      if (active !== undefined && pendingReplay && active.resultSeen) {
        // The replay starts the steer's own run; evidence alone must not let the
        // previous result settle the logical turn before that run's result.
        active.resultSeen = false;
        active.idleSeen = false;
        this.clearSteerTimer();
        this.clearIdleTimer();
        this.clearHoldTimer();
        if (active.mainRun !== "running") {
          active.mainRun = "running";
          await this.emit([{ op: "turn.mainRun", scope: this.scope(), state: "running" }]);
        }
        this.armHoldTimer(active);
        startedNewRun = true;
      }
      await this.consumeEvidence([record.uuid], undefined);
    }
    const blocks = contentBlocks(message);
    for (const block of blocks) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const active = this.active;
      if (active === undefined) {
        await this.warnOutsideTurn("tool result arrived with no open turn");
        continue;
      }
      const output = boundedText(textOfContent(block.content));
      const failed = block.is_error === true;
      const tool = this.tools.get(block.tool_use_id);
      const shape: ItemShape = tool !== undefined
        ? { ...tool.shape, status: failed ? "failed" : "completed", output } as ItemShape
        : { kind: "tool", name: "tool", status: failed ? "failed" : "completed", output };
      this.tools.delete(block.tool_use_id);
      await this.emit([{ op: "item.close", scope: this.scope(), nativeKey: block.tool_use_id, shape }]);
    }
    if (!startedNewRun) {
      this.clearTimers();
      const active = this.active;
      if (active?.resultSeen) {
        if (active.pending.size > 0 || active.queuedTurns > 0) this.armSteerTimer(active);
        if (active.background.size > 0 || active.backgroundWasLive) this.armIdleTimer(active);
      }
    }
    if (this.active !== undefined) this.armHoldTimer(this.active);
  }

  private async handleResult(message: unknown): Promise<void> {
    if (!isRecord(message)) return;
    const uuids = resultUuids(message);
    if (uuids.present) this.uuidSupport = true;
    else if (this.uuidSupport !== true) this.uuidSupport = false;
    if (uuids.present) await this.consumeEvidence(uuids.uuids, stringField(message, "uuid"));
    const active = this.active;
    if (active === undefined) return;
    this.clearTimers();
    active.resultSeen = true;
    active.idleSeen = false;
    active.resultsSinceSteer += 1;
    active.queuedTurns = numberField(message, "queued_turn_count") ?? 0;
    active.resultStatus = resultStatus(message);
    if (active.mainRun !== "idle") {
      active.mainRun = "idle";
      await this.emit([{ op: "turn.mainRun", scope: this.scope(), state: "idle" }]);
    }
    const usage = usageOfResult(message);
    if (usage !== null) {
      await this.emit([
        { op: "usage", scope: this.scope(), ...usage },
        {
          op: "contextWindow",
          scope: this.scope(),
          usedTokens: usage.last.inputTokens + usage.last.cachedInputTokens + usage.last.cacheWriteInputTokens,
          modelContextWindow: usage.modelContextWindow,
        },
      ]);
    }
    if (active.pending.size > 0 && !uuids.present && active.resultsSinceSteer >= 2) {
      // Older CLIs cannot name consumed prompts. This follow-up result is the
      // best available turn boundary; evidence stays admission-only.
      active.pending.clear();
    }
    if (active.pending.size > 0 && active.resultStatus !== "completed"
      && active.queuedTurns === 0 && active.background.size === 0) {
      // A terminal failed turn with no queued follow-up cannot run the steer;
      // keep the admitted fact and settle it as unknown rather than success.
      await this.settleUnconfirmed("Claude turn ended before the steer was confirmed");
    }
    await this.maybeSettle();
  }

  private async maybeSettle(): Promise<void> {
    const active = this.active;
    if (active === undefined || !active.resultSeen || this.closed) return;
    if (active.mainRun === "running") return;
    if (active.pending.size > 0) {
      if (this.uuidSupport !== true && active.resultsSinceSteer >= 2) {
        active.pending.clear();
      } else {
        this.armHoldTimer(active);
        this.armSteerTimer(active);
        return;
      }
    }
    if (active.queuedTurns > 0) {
      this.armHoldTimer(active);
      this.armSteerTimer(active);
      return;
    }
    if (active.idleSeen) {
      await this.closeTurn(active.resultStatus);
      return;
    }
    if (active.background.size > 0) {
      active.backgroundWasLive = true;
      this.armHoldTimer(active);
      this.armIdleTimer(active);
      return;
    }
    if (active.backgroundWasLive && !active.idleSeen) {
      this.armHoldTimer(active);
      this.armIdleTimer(active);
      return;
    }
    await this.closeTurn(active.resultStatus);
  }

  private armSteerTimer(active: ActiveTurn): void {
    this.clearSteerTimer();
    this.steerTimer = setTimeout(() => {
      this.steerTimer = undefined;
      void this.queue.run(async () => {
        if (this.active !== active) return;
        if (active.mainRun === "running" || active.background.size > 0 || active.queuedTurns > 0) {
          this.armSteerTimer(active);
          return;
        }
        for (const inputId of [...active.pending]) {
          const record = this.inputs.get(inputId);
          if (record === undefined || record.evidence === "context-confirmed") continue;
          record.outcome = "unknown";
          record.version += 1;
          await this.emit([
            {
              op: "input.outcome",
              scope: this.scope(),
              inputId,
              state: "unknown",
              reason: "Steer was admitted to the SDK input stream but produced no native consumption evidence",
              version: record.version,
            },
          ]);
        }
        active.pending.clear();
        if (this.active === active) await this.closeTurn(active.resultStatus);
      }).catch(() => {});
    }, this.options.steerWaitTimeoutMs ?? DEFAULT_STEER_WAIT_MS);
    this.steerTimer.unref();
  }

  private armHoldTimer(active: ActiveTurn): void {
    if (this.holdTimer !== undefined) return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = undefined;
      void this.queue.run(async () => {
        if (this.active !== active) return;
        await this.settleUnconfirmed("Claude turn exceeded the bridge hold limit before completion").catch(() => {});
        if (this.active === active) await this.closeTurn(active.resultStatus);
      }).catch(() => {});
    }, this.options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS);
    this.holdTimer.unref();
  }

  private armIdleTimer(active: ActiveTurn): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.queue.run(async () => {
        if (this.active !== active || active.pending.size > 0) return;
        if (active.mainRun === "running" || active.background.size > 0) {
          this.armIdleTimer(active);
          return;
        }
        await this.closeTurn(active.resultStatus);
      }).catch(() => {});
    }, this.options.backgroundIdleGraceMs ?? DEFAULT_IDLE_GRACE_MS);
    this.idleTimer.unref();
  }

  private async settleUnconfirmed(reason: string): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    for (const inputId of [...active.pending]) {
      const record = this.inputs.get(inputId);
      if (record === undefined || record.evidence === "context-confirmed") continue;
      record.outcome = record.admitted ? "unknown" : "failed";
      record.version += 1;
      await this.emit([
        {
          op: "input.outcome",
          scope: this.scope(),
          inputId,
          state: record.admitted ? "unknown" : "failed",
          reason,
          version: record.version,
        },
      ]);
    }
    active.pending.clear();
  }

  private async closeTurn(status: TurnStatus): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    this.active = undefined;
    this.clearTimers();
    await this.emit([{ op: "turn.close", scope: this.scope(), nativeTurnId: active.nativeTurnId, status }]);
  }

  private async handleNativeEnd(error: unknown): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    const active = this.active;
    if (active !== undefined) {
      await this.settleUnconfirmed(
        error instanceof Error ? error.message : "Claude SDK message stream ended",
      ).catch(() => {});
      await this.closeTurn("failed").catch(() => {});
    }
    await this.emit([
      {
        op: "session.ended",
        scope: this.scope(),
        reason: error instanceof Error ? error.message : "Claude SDK message stream ended",
      },
    ]).catch(() => {});
    await this.native?.close().catch(() => {});
    this.native = undefined;
  }

  private async openTool(nativeKey: string, name: string, input: Record<string, unknown>, parentRef: { parentRef?: string }): Promise<void> {
    if (this.tools.has(nativeKey)) return;
    const shape: ItemShape = name === "Bash"
      ? {
          kind: "command",
          command: typeof input.command === "string" ? input.command : "",
          cwd: typeof input.cwd === "string" ? input.cwd : this.options.cwd,
          status: "inProgress",
        }
      : { kind: "tool", name, status: "inProgress" };
    this.tools.set(nativeKey, { name, shape });
    await this.emit([{ op: "item.open", scope: { ...this.scope(), ...parentRef }, nativeKey, shape }]);
  }

  private async emitTextItem(nativeKey: string, channel: "agentMessage" | "reasoning", text: string, parentRef: { parentRef?: string }): Promise<void> {
    if (text.length === 0) return;
    const emptyShape: ItemShape = channel === "reasoning"
      ? { kind: "reasoning", text: "" }
      : { kind: "agentMessage", text: "" };
    await this.emit([
      { op: "item.open", scope: { ...this.scope(), ...parentRef }, nativeKey, shape: emptyShape },
      { op: "item.textDelta", scope: { ...this.scope(), ...parentRef }, nativeKey, channel, text },
      { op: "item.textClose", scope: { ...this.scope(), ...parentRef }, nativeKey, channel, text },
    ]);
  }

  private async consumeEvidence(uuids: readonly string[], runId: string | undefined): Promise<void> {
    const wanted = new Set(uuids);
    for (const record of this.inputs.values()) {
      if (record.evidence === "context-confirmed" || !wanted.has(record.uuid)) continue;
      record.evidence = "context-confirmed";
      record.evidenceRef = record.uuid;
      record.runId = runId ?? null;
      record.outcome = "context-confirmed";
      record.version += 1;
      this.active?.pending.delete(record.inputId);
      await this.emit([
        {
          op: "input.evidence",
          scope: this.scope(),
          inputId: record.inputId,
          evidenceKind: "context-confirmed",
          evidenceRef: record.uuid,
          nativeInputId: record.uuid,
          ...(runId !== undefined ? { runId } : {}),
          version: record.version,
        },
      ]);
    }
  }

  private async emitAdmission(record: InputRecord): Promise<void> {
    record.admitted = true;
    record.deliveryMethod = "native-inject";
    record.outcome = "evidence-observed";
    record.version += 1;
    await this.emit([
      {
        op: "input.delivery",
        scope: this.scope(),
        inputId: record.inputId,
        deliveryMethod: "native-inject",
        admitted: true,
        nativeInputId: record.uuid,
        version: record.version,
      },
    ]);
    record.evidence = "evidence-observed";
    record.version += 1;
    await this.emit([
      {
        op: "input.evidence",
        scope: this.scope(),
        inputId: record.inputId,
        evidenceKind: "admission",
        nativeInputId: record.uuid,
        version: record.version,
      },
    ]);
  }

  private async setWithdrawal(record: InputRecord, state: "withdrawn" | "too-late" | "unsupported"): Promise<void> {
    record.withdrawal = state;
    if (state !== "unsupported") record.outcome = state;
    record.version += 1;
    await this.emit([
      {
        op: "input.withdrawal",
        scope: this.scope(),
        inputId: record.inputId,
        state,
        version: record.version,
      },
    ]);
  }

  private registerInput(input: {
    inputId: string;
    clientRequestId: string;
    text: string;
    nativeTurnId: string;
  }): InputRecord {
    const record: InputRecord = {
      inputId: input.inputId,
      clientRequestId: input.clientRequestId,
      uuid: randomUUID(),
      text: input.text,
      nativeTurnId: input.nativeTurnId,
      deliveryMethod: null,
      admitted: false,
      evidence: "none",
      evidenceRef: null,
      runId: null,
      withdrawal: "none",
      outcome: "registered",
      version: 0,
    };
    this.inputs.set(record.inputId, record);
    return record;
  }

  private statusOf(record: InputRecord): InputStatus {
    return {
      inputId: record.inputId,
      clientRequestId: record.clientRequestId,
      nativeInputId: record.uuid,
      expectedTurnId: record.nativeTurnId,
      deliveryMethod: record.deliveryMethod,
      admitted: record.admitted,
      evidence: record.evidence,
      evidenceRef: record.evidenceRef,
      runId: record.runId,
      withdrawal: record.withdrawal,
      outcome: record.outcome,
      version: record.version,
    };
  }

  private validateText(text: unknown): string {
    if (typeof text !== "string" || text.trim().length === 0) throw invalid("Input text must be a non-empty string");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > 64 * 1024) throw invalid("Input text exceeds the 64 KiB bridge limit");
    return text;
  }

  private validateId(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0 || value.length > 512) {
      throw invalid(`${field} must be a non-empty string of at most 512 characters`);
    }
    return value;
  }

  private requireOpen(): void {
    if (this.closed) throw staleTarget("Claude session is closed");
    if (this.info === undefined) throw staleTarget("Claude session is not initialized");
  }

  private scope(): { threadId: string } {
    return { threadId: this.options.scopeId };
  }

  private async emit(deltas: readonly BridgeDelta[]): Promise<void> {
    if (deltas.length > 0) await this.options.emit(deltas);
  }

  private async warnOutsideTurn(reason: string): Promise<void> {
    if (this.warnedOutsideTurn) return;
    this.warnedOutsideTurn = true;
    await this.emit([{ op: "unhandled", scope: this.scope(), reason }]).catch(() => {});
  }

  private clearSteerTimer(): void {
    if (this.steerTimer !== undefined) clearTimeout(this.steerTimer);
    this.steerTimer = undefined;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private clearHoldTimer(): void {
    if (this.holdTimer !== undefined) clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
  }

  private clearTimers(): void {
    this.clearSteerTimer();
    this.clearIdleTimer();
    this.clearHoldTimer();
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
