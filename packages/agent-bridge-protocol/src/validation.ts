/**
 * Boundary parsing and outcome settlement. Unknown data is narrowed here, at
 * the system edge; internal code only ever sees typed deltas. A `thread/delta`
 * payload must be fully valid (what it assembles into is durable), while
 * envelope-level framing stays tolerant of unknown fields.
 */

import { APP_SERVER_ACTIVITY_TYPES, COMMAND_SOURCES, type AgentMessageQuestion, type AppServerActivityType, type BridgeDelta,
  type BridgeDeltaOp, type CommandAction, type ThreadDeltaParams, type TokenUsage } from "./grammar";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isString(value: unknown): value is string {
  return typeof value === "string";
}
function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}
function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isString);
}
function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return isString(value) && (allowed as readonly string[]).includes(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || isString(value);
}

export function isAgentMessageQuestions(value: unknown): value is readonly AgentMessageQuestion[] {
  return Array.isArray(value) && value.every(question => isRecord(question) && isString(question.title) &&
    (question.options === null || isStringArray(question.options)));
}

export function isCommandActions(value: unknown): value is readonly CommandAction[] {
  return Array.isArray(value) && value.every(action => {
    if (!isRecord(action) || !isString(action.command)) return false;
    switch (action.type) {
      case "read": return isString(action.name) && isString(action.path);
      case "listFiles": return isNullableString(action.path);
      case "search": return isNullableString(action.path) && isNullableString(action.query);
      case "unknown": return true;
      default: return false;
    }
  });
}

export function isReasoningContentIndex(value: unknown): value is number {
  // Section indices grow an array in both the assembler and the client.
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 4096;
}

export function isTerminalInteraction(value: unknown): boolean {
  return isRecord(value) && isString(value.turnId) && isString(value.itemId) &&
    isString(value.processId) && isString(value.stdin);
}

export function isAppServerActivityType(value: unknown): value is AppServerActivityType {
  return isOneOf(value, APP_SERVER_ACTIVITY_TYPES);
}

function isAppServerItem(item: unknown): boolean {
  if (!isRecord(item) || Object.hasOwn(item, "id")) return false;
  switch (item.type) {
    case "contextCompaction":
      return true;
    case "webSearch": {
      const action = item.action;
      return isString(item.query) && (action == null || isRecord(action) && (
        action.type === "search" && isNullableString(action.query) && (action.queries === null || isStringArray(action.queries)) ||
        action.type === "openPage" && isNullableString(action.url) ||
        action.type === "findInPage" && isNullableString(action.url) && isNullableString(action.pattern) ||
        action.type === "other"
      )) && (item.results == null || Array.isArray(item.results));
    }
    case "collabAgentToolCall":
      return isOneOf(item.tool, ["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent", "sendMessage",
        "followupTask", "interruptAgent", "listAgents"]) &&
        isOneOf(item.status, [...ITEM_TOOL_STATUSES, "interrupted"]) && isString(item.senderThreadId) &&
        isStringArray(item.receiverThreadIds) && isNullableString(item.prompt) && isNullableString(item.model) &&
        isNullableString(item.reasoningEffort) && isRecord(item.agentsStates) &&
        Object.values(item.agentsStates).every(state => isRecord(state) &&
          isOneOf(state.status, ["pendingInit", "running", "interrupted", "completed", "errored", "shutdown", "notFound"]) &&
          isNullableString(state.message));
    case "subAgentActivity":
      return isOneOf(item.kind, ["started", "interacted", "interrupted", "completed"]) &&
        isString(item.agentThreadId) && isString(item.agentPath);
    case "hookPrompt":
      return Array.isArray(item.fragments) && item.fragments.every(fragment =>
        isRecord(fragment) && isString(fragment.text) && isString(fragment.hookRunId));
    case "imageGeneration":
      return isString(item.status) && isString(item.result) && (item.savedPath === undefined || isString(item.savedPath));
    case "mcpToolCall":
      return isString(item.status) && isString(item.server) && isString(item.tool) && (item.result == null ||
        isRecord(item.result) && Array.isArray(item.result.content));
    case "dynamicToolCall":
      return isString(item.status) && isString(item.tool) && (item.contentItems == null || Array.isArray(item.contentItems));
    default:
      return false;
  }
}

const TURN_STATUSES = ["completed", "failed", "interrupted"] as const;
const TEXT_CHANNELS = ["agentMessage", "reasoning", "plan"] as const;
const ITEM_TOOL_STATUSES = ["inProgress", "completed", "failed"] as const;
const DELIVERY_METHODS = ["native-inject", "next-turn", "interrupt-replace"] as const;
const EVIDENCE_KINDS = ["context-confirmed", "native-input-id", "admission", "echo", "queue-change"] as const;
const WITHDRAWAL_STATES = ["withdraw-requested", "withdrawn", "too-late", "unsupported", "unknown"] as const;
const RECOVERY_KINDS = ["sessionArchived", "authRequired", "restartRecommended", "staleTurn", "rateLimited"] as const;

const DELTA_OPS: readonly BridgeDeltaOp[] = [
  "turn.open", "turn.boundary", "turn.mainRun", "turn.close",
  "item.open", "item.progress", "item.textDelta", "item.textClose", "item.close",
  "input.accepted", "input.delivery", "input.evidence", "input.withdrawal", "input.outcome",
  "usage", "contextWindow", "session.reset", "session.ended",
  "extension.state", "provider.recovery", "unhandled",
];

function isScope(value: unknown): boolean {
  return isRecord(value) && isString(value.threadId);
}

function isTokenUsage(value: unknown): value is TokenUsage {
  if (!isRecord(value)) return false;
  return isNumber(value.totalTokens) && isNumber(value.inputTokens)
    && isNumber(value.cachedInputTokens) && isNumber(value.cacheWriteInputTokens)
    && isNumber(value.outputTokens) && isNumber(value.reasoningOutputTokens);
}

function isItemShape(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.kind)) return false;
  switch (value.kind) {
    case "userMessage":
      return isString(value.text) && (value.clientId === undefined || value.clientId === null || isString(value.clientId))
        && (value.content === undefined || Array.isArray(value.content) && value.content.every(part => isRecord(part) && isString(part.type))
          && JSON.stringify(value.content).length <= 65_536);
    case "agentMessage":
      return isString(value.text) &&
        (value.phase === undefined || isOneOf(value.phase, ["commentary", "final_answer"])) &&
        (value.delivery === undefined || value.delivery === "async") &&
        (value.questions === undefined || isAgentMessageQuestions(value.questions));
    case "plan":
      return isString(value.text);
    case "reasoning":
      return isString(value.text) && (value.summary === undefined || isStringArray(value.summary)) &&
        (value.content === undefined || isStringArray(value.content));
    case "appServerItem":
      return isAppServerItem(value.item);
    case "tool":
      return isString(value.name) && isOneOf(value.status, ITEM_TOOL_STATUSES)
        && (value.output === undefined || value.output === null || isString(value.output));
    case "fileChange":
      return isOneOf(value.status, [...ITEM_TOOL_STATUSES, "declined"]) &&
        Array.isArray(value.changes) && value.changes.length <= 64 && JSON.stringify(value.changes).length <= 256 * 1024 &&
        value.changes.every(change => isRecord(change) && isString(change.path) && isString(change.diff) &&
          isRecord(change.kind) && (change.kind.type === "add" || change.kind.type === "delete" ||
            (change.kind.type === "update" && (change.kind.move_path === null || isString(change.kind.move_path)))));
    case "command":
      return isString(value.command) && isString(value.cwd) && isOneOf(value.status, [...ITEM_TOOL_STATUSES, "declined"])
        && (value.processId === undefined || isNullableString(value.processId))
        && (value.source === undefined || isOneOf(value.source, COMMAND_SOURCES))
        && (value.commandActions === undefined || isCommandActions(value.commandActions))
        && (value.output === undefined || value.output === null || isString(value.output))
        && (value.exitCode == null || (typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode)))
        && (value.durationMs == null || isNumber(value.durationMs));
    default:
      return false;
  }
}

export interface DeltaParseResult {
  readonly ok: boolean;
  readonly delta?: BridgeDelta;
  readonly reason?: string;
}

function fail(reason: string): DeltaParseResult {
  return { ok: false, reason };
}

/**
 * Validate and narrow one raw delta. The core is strict: a malformed delta is
 * rejected by name rather than being quietly assembled into durable state.
 */
export function parseDelta(value: unknown): DeltaParseResult {
  if (!isRecord(value)) return fail("delta is not an object");
  if (!isString(value.op) || !isOneOf(value.op, DELTA_OPS)) return fail("delta has an unknown op");
  if (!isScope(value.scope)) return fail("delta is missing a valid source scope");
  const op = value.op as BridgeDeltaOp;

  const requireNativeKey = (): boolean => isString(value.nativeKey);
  const requireString = (key: string): boolean => isString(value[key]);

  switch (op) {
    case "turn.open":
      if (!requireString("nativeTurnId")) return fail("turn.open needs nativeTurnId");
      if (value.expectedInputIds !== undefined && !isStringArray(value.expectedInputIds)) return fail("bad expectedInputIds");
      break;
    case "turn.boundary":
      if (!requireString("nativeTurnId") || !isOneOf(value.status, TURN_STATUSES)) return fail("turn.boundary needs nativeTurnId/status");
      break;
    case "turn.mainRun":
      if (!isOneOf(value.state, ["idle", "running"] as const)) return fail("turn.mainRun needs idle|running state");
      break;
    case "turn.close":
      if (!requireString("nativeTurnId") || !isOneOf(value.status, TURN_STATUSES)) return fail("turn.close needs nativeTurnId/status");
      if (value.error !== undefined && (value.status !== "failed" || !isRecord(value.error) || !isString(value.error.message)
        || (value.error.additionalDetails !== undefined && value.error.additionalDetails !== null && !isString(value.error.additionalDetails))
        || JSON.stringify(value.error).length > 16_384)) return fail("turn.close error needs failed status and a bounded message");
      break;
    case "item.open":
      if (!requireNativeKey() || !isItemShape(value.shape)) return fail("item.open needs nativeKey/shape");
      break;
    case "item.progress":
      if (!requireNativeKey()) return fail("item.progress needs nativeKey");
      break;
    case "item.textDelta":
      if (!requireNativeKey() || !isOneOf(value.channel, TEXT_CHANNELS) || !isString(value.text)) return fail("item.textDelta needs nativeKey/channel/text");
      if (value.contentIndex !== undefined && (value.channel !== "reasoning" || !isReasoningContentIndex(value.contentIndex))) {
        return fail("item.textDelta contentIndex needs a bounded reasoning section index");
      }
      break;
    case "item.textClose":
      if (!requireNativeKey() || !isOneOf(value.channel, TEXT_CHANNELS)) return fail("item.textClose needs nativeKey/channel");
      if (value.text !== undefined && !isString(value.text)) return fail("bad item.textClose text");
      break;
    case "item.close":
      if (!requireNativeKey() || !isItemShape(value.shape)) return fail("item.close needs nativeKey/shape");
      break;
    case "input.accepted":
      if (!requireString("inputId") || !requireString("clientRequestId")) return fail("input.accepted needs inputId/clientRequestId");
      if (value.allowedPaths !== undefined && !isStringArray(value.allowedPaths)) return fail("bad allowedPaths");
      if (value.disposition !== undefined
        && !isOneOf(value.disposition, ["steered", "next-turn", "interrupt-replace"] as const)) return fail("bad input disposition");
      break;
    case "input.delivery":
      if (!requireString("inputId") || !isOneOf(value.deliveryMethod, DELIVERY_METHODS)
        || !isBoolean(value.admitted) || !isNumber(value.version)) return fail("input.delivery needs inputId/method/admitted/version");
      break;
    case "input.evidence":
      if (!requireString("inputId") || !isOneOf(value.evidenceKind, EVIDENCE_KINDS)
        || !isNumber(value.version)) return fail("input.evidence needs inputId/kind/version");
      break;
    case "input.withdrawal":
      if (!requireString("inputId") || !isOneOf(value.state, WITHDRAWAL_STATES)
        || !isNumber(value.version)) return fail("input.withdrawal needs inputId/state/version");
      break;
    case "input.outcome":
      if (!requireString("inputId") || !isOneOf(value.state, ["unknown", "rejected", "failed"] as const)
        || !requireString("reason") || !isNumber(value.version)) return fail("input.outcome needs inputId/state/reason/version");
      break;
    case "usage":
      if (!isTokenUsage(value.total) || !isTokenUsage(value.last)
        || !(value.modelContextWindow === null || isNumber(value.modelContextWindow))) return fail("usage needs total/last/modelContextWindow");
      break;
    case "contextWindow":
      if (!isNumber(value.usedTokens) || !(value.modelContextWindow === null || isNumber(value.modelContextWindow))) return fail("contextWindow needs usedTokens/modelContextWindow");
      break;
    case "session.reset":
    case "session.ended":
      if (value.reason !== undefined && !isString(value.reason)) return fail("bad session reason");
      break;
    case "extension.state":
      if (!requireString("extensionKind") || !("state" in value)) return fail("extension.state needs extensionKind/state");
      break;
    case "provider.recovery":
      if (!isOneOf(value.kind, RECOVERY_KINDS) || !isString(value.message) || !isBoolean(value.retryable)) return fail("provider.recovery needs kind/message/retryable");
      break;
    case "unhandled":
      if (!requireString("reason")) return fail("unhandled needs reason");
      break;
  }

  // Preserve any forward-skew fields; the cast is safe after the checks above.
  return { ok: true, delta: value as unknown as BridgeDelta };
}

export interface ThreadDeltaParseResult {
  readonly ok: boolean;
  readonly params?: ThreadDeltaParams;
  readonly reason?: string;
}

/** Validate a `thread/delta` payload strictly, one delta at a time. */
export function parseThreadDeltaParams(value: unknown): ThreadDeltaParseResult {
  if (!isRecord(value) || !isString(value.threadId) || !Array.isArray(value.deltas)) {
    return { ok: false, reason: "thread/delta needs threadId and a deltas array" };
  }
  const deltas: BridgeDelta[] = [];
  for (const raw of value.deltas) {
    const parsed = parseDelta(raw);
    if (!parsed.ok || parsed.delta === undefined) {
      return { ok: false, reason: parsed.reason ?? "invalid delta" };
    }
    deltas.push(parsed.delta);
  }
  return { ok: true, params: { threadId: value.threadId, deltas } };
}

/** A command's settlement state on the Host ledger. */
export type CommandOutcomeState = "dispatching" | "accepted" | "not-sent" | "unknown" | "rejected" | "failed";

export interface CommandRecord {
  readonly commandId: string;
  readonly state: CommandOutcomeState;
  /** The command was written to the wire before the interruption. */
  readonly writeAcked: boolean;
  /** A terminal reply was observed. */
  readonly replyReceived: boolean;
  /** The connection reached EOF / reconnected after the write. */
  readonly reconnectAfterWrite: boolean;
  /** Proof from native requestId/session history, if any. */
  readonly nativeProof?: "accepted" | "not-sent";
}

export interface OutcomeSettlement {
  readonly outcome: CommandOutcomeState;
  readonly reconcileRequired: boolean;
  /** Re-executing the native mutation is never allowed. */
  readonly replayAllowed: false;
  /** Re-querying the same commandId / re-sending a recorded receipt is allowed. */
  readonly queryAllowed: boolean;
  readonly reason: string;
}

/**
 * Settle an outcome after a possible write-then-EOF gap. Only native proof
 * may resolve an unacknowledged write; otherwise the result stays `unknown`
 * and exposes a reconciliation action. Never re-runs the native request.
 */
export function settleCommandOutcome(record: CommandRecord): OutcomeSettlement {
  const base = { replayAllowed: false as const };
  if (record.replyReceived) {
    return { ...base, outcome: record.state, reconcileRequired: false, queryAllowed: true, reason: "terminal reply observed" };
  }
  if (record.nativeProof === "accepted") {
    return { ...base, outcome: "accepted", reconcileRequired: false, queryAllowed: true, reason: "native history proves admission" };
  }
  if (record.nativeProof === "not-sent") {
    return { ...base, outcome: "not-sent", reconcileRequired: false, queryAllowed: true, reason: "native history proves not sent" };
  }
  if (record.writeAcked && record.reconnectAfterWrite) {
    return { ...base, outcome: "unknown", reconcileRequired: true, queryAllowed: true, reason: "written before EOF with no native proof; reconcile, do not replay" };
  }
  return { ...base, outcome: "unknown", reconcileRequired: true, queryAllowed: true, reason: "no terminal reply or proof; keep unknown" };
}
