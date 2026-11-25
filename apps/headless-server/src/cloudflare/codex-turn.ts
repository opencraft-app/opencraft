import {
  isJsonRpcFailure,
  isJsonRpcSuccess,
  isJsonRpcRequest,
  isHumanInteraction,
  parseJsonRpcMessage,
  parseSharedInteractionSnapshot,
  OPENCRAFT_STEER_EVIDENCE_EXTENSION,
  SIDE_CHAT_INSTRUCTIONS,
  threadCatalogEntry,
  SHARED_INTERACTIONS_CHANGED,
  SHARED_INTERACTIONS_READ,
  SHARED_INTERACTIONS_RESPOND,
  type InteractionSourceRequest,
  type JsonRpcNotification,
  type JsonRpcIncomingMessage,
  type SharedInteractionSnapshot,
  type TurnInterruptParams,
} from "@opencraft/appserver-protocol";
import type {
  CommandAction,
  FileUpdateChange,
  ThreadItem,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  TurnPlanStep,
} from "@opencraft/appserver-protocol/generated/v2";
import type { HostInteractions } from "@opencraft/app-host-server/interactions";
import type { InstallationCoreNamespace } from "./bindings.js";
import { parseClientAttachment, type ClientAttachment } from "./client-attachment.js";
import { isCodexModelId } from "./codex-thread-start.js";
import { parseThreadPlacementReceipt, type ThreadPlacementReceipt } from "./thread-placement.js";
import type { WorkspaceCodex } from "./workspace-codex.js";
import { EndpointRpcError, type EndpointWebSocket } from "./workspace-link.js";

export const CODEX_TURN_AUTHORITY_PATH = "/__opencraft_internal/codex-turn/authority";
/** Keep native Workbench interactions available when the owner resumes a thread. */
export const CODEX_WORKBENCH_THREAD_CONFIG = Object.freeze({
  "tools.update_plan.enabled": true,
  "features.default_mode_request_user_input": true,
});

const isNativeId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,512}$/u.test(value);
const isCodexThreadId = (value: unknown): value is string =>
  isNativeId(value) || (typeof value === "string" && /^bridge:codex:[A-Za-z0-9_-]{1,499}$/u.test(value));
const isCodexTurnId = (value: unknown): value is string =>
  isNativeId(value) || (typeof value === "string" && /^t[0-9]{1,16}\.[0-9]{1,16}$/u.test(value));
const isInputId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9:_-]{1,256}$/u.test(value);

export interface CodexTurn {
  readonly threadId: string;
  readonly clientUserMessageId: string;
  readonly input: readonly { readonly type: "text"; readonly text: string; readonly text_elements: readonly [] }[];
  readonly model?: string;
  readonly effort?: string;
}

export function parseCodexTurn(value: unknown): CodexTurn | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { threadId, clientUserMessageId, input, model, effort, serviceTier } = value as Partial<CodexTurn> & {
    serviceTier?: unknown;
  };
  if (
    !isCodexThreadId(threadId) ||
    !isInputId(clientUserMessageId) ||
    Object.keys(value).some(
      (key) => !["threadId", "clientUserMessageId", "input", "model", "effort", "serviceTier"].includes(key),
    ) ||
    // Native null inherits the current tier, exactly like omission.
    serviceTier != null ||
    (model != null && !isCodexModelId(model)) ||
    (effort != null && (typeof effort !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/u.test(effort)))
  )
    return null;
  const parts = parseTurnText(input);
  return (
    parts && {
      threadId,
      clientUserMessageId,
      input: parts,
      ...(typeof model === "string" ? { model } : {}),
      ...(typeof effort === "string" ? { effort } : {}),
    }
  );
}

function parseTurnText(input: unknown): CodexTurn["input"] | null {
  if (!Array.isArray(input) || input.length < 1 || input.length > 16) return null;
  let size = 0;
  const parts: CodexTurn["input"][number][] = [];
  for (const part of input) {
    if (
      !part ||
      typeof part !== "object" ||
      Array.isArray(part) ||
      part.type !== "text" ||
      typeof part.text !== "string" ||
      !part.text.length ||
      Object.keys(part).some((key) => !["type", "text", "text_elements"].includes(key)) ||
      (part.text_elements !== undefined && (!Array.isArray(part.text_elements) || part.text_elements.length !== 0))
    )
      return null;
    size += new TextEncoder().encode(part.text).byteLength;
    if (size > 32 * 1024) return null;
    parts.push({ type: "text", text: part.text, text_elements: [] });
  }
  return parts;
}

export type TurnAuthority = {
  readonly placement: ThreadPlacementReceipt;
  readonly principal: {
    readonly provider: string;
    readonly subject: string;
    readonly actorId: string;
    readonly actorGeneration: number;
  };
};

export async function codexTurnAuthority(
  installation: ReturnType<InstallationCoreNamespace["get"]>,
  attachment: ClientAttachment,
  threadId: string,
): Promise<TurnAuthority | null> {
  const response = await installation.fetch(
    new Request(`https://installation.invalid${CODEX_TURN_AUTHORITY_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attachment, threadId }),
    }),
  );
  if (!response.ok) {
    await response.body?.cancel();
    if ([401, 403, 404].includes(response.status)) return null;
    throw new Error("Turn authorization unavailable");
  }
  const value = (await response.json()) as Partial<TurnAuthority> | null;
  const placement = parseThreadPlacementReceipt(value?.placement);
  const principal = value?.principal;
  if (
    placement?.state !== "placed" ||
    placement.threadId !== threadId ||
    typeof principal?.provider !== "string" ||
    !principal.provider ||
    typeof principal.subject !== "string" ||
    !principal.subject ||
    principal.actorId !== attachment.actorId ||
    principal.actorGeneration !== attachment.actorGeneration
  )
    throw new Error("Invalid Turn authorization");
  return { placement, principal };
}

export function parseCodexTurnCall(value: unknown) {
  const packet = value as { attachment?: unknown; turn?: unknown; placement?: unknown } | null;
  const attachment = parseClientAttachment(packet?.attachment);
  const turn = parseCodexTurn(packet?.turn);
  const placement = parseThreadPlacementReceipt(packet?.placement);
  return attachment && turn && placement?.state === "placed" && placement.threadId === turn.threadId
    ? { attachment, turn, placement }
    : null;
}

function parseCodexTurnInterrupt(value: unknown): TurnInterruptParams | null {
  const fields = record(value);
  const { threadId, turnId } = fields;
  return Object.keys(fields).length === 2 && isCodexThreadId(threadId) && isCodexTurnId(turnId)
    ? { threadId, turnId }
    : null;
}

export function isCodexThreadMutation(
  method: string,
): method is "thread/name/set" | "thread/archive" | "thread/unarchive" | "thread/settings/update" {
  return (
    method === "thread/name/set" ||
    method === "thread/archive" ||
    method === "thread/unarchive" ||
    method === "thread/settings/update"
  );
}

export function parseCodexUnsubscribe(params: unknown): string | null {
  const fields = record(params);
  return Object.keys(fields).length === 1 && isCodexThreadId(fields.threadId) ? fields.threadId : null;
}

export function parseCodexTurnOperation(method: string, params: unknown) {
  if (method === "turn/interrupt") {
    const turn = parseCodexTurnInterrupt(params);
    return turn ? { kind: "interrupt" as const, ...turn } : null;
  }
  const fields = record(params);
  const { threadId, interactionId, submissionId, result } = fields;
  if (!isCodexThreadId(threadId)) return null;
  if (isCodexThreadMutation(method)) {
    if (method === "thread/name/set") {
      const { name } = fields;
      if (
        Object.keys(fields).length !== 2 ||
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 1024 ||
        /[\x00-\x1f\x7f]/u.test(name)
      )
        return null;
      return { kind: "thread-mutation" as const, method, threadId, params: { threadId, name } };
    }
    if (method === "thread/settings/update") {
      const mode = record(fields.collaborationMode);
      const settings = record(mode.settings);
      const { model, reasoning_effort: effort, developer_instructions: instructions } = settings;
      if (
        Object.keys(fields).length !== 2 ||
        Object.keys(mode).length !== 2 ||
        mode.mode !== "default" ||
        Object.keys(settings).length !== 3 ||
        !isCodexModelId(model) ||
        (effort !== null && (typeof effort !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/u.test(effort))) ||
        instructions !== SIDE_CHAT_INSTRUCTIONS
      )
        return null;
      return {
        kind: "thread-mutation" as const,
        method,
        threadId,
        params: { threadId, collaborationMode: sideChatMode(model, effort) },
      };
    }
    return Object.keys(fields).length === 1
      ? { kind: "thread-mutation" as const, method, threadId, params: { threadId } }
      : null;
  }
  if (method === "turn/steer") {
    const { expectedTurnId, clientUserMessageId, input } = fields;
    if (Object.keys(fields).length !== 4 || !isCodexTurnId(expectedTurnId) || !isInputId(clientUserMessageId))
      return null;
    const parts = parseTurnText(input);
    if (!parts || new TextEncoder().encode(JSON.stringify(parts)).byteLength > 48 * 1024) return null;
    return { kind: "steer" as const, threadId, expectedTurnId, clientUserMessageId, input: parts };
  }
  if (method === "thread/resume") {
    const { excludeTurns, history, path, cwd, model, modelProvider } = record(params);
    if (
      (excludeTurns !== undefined && typeof excludeTurns !== "boolean") ||
      history != null ||
      Object.keys(record(params)).some(
        (key) => !["threadId", "excludeTurns", "history", "path", "cwd", "model", "modelProvider"].includes(key),
      ) ||
      [path, cwd, model, modelProvider].some((item) => item != null && typeof item !== "string")
    )
      return null;
    // Workbench sends saved metadata alongside the id. These are consistency
    // checks against Native's receipt and never select a path or configuration.
    return {
      kind: "resume" as const,
      threadId,
      excludeTurns: excludeTurns === true,
      hints: { path, cwd, model, modelProvider },
    };
  }
  if (method === SHARED_INTERACTIONS_READ && Object.keys(record(params)).length === 1)
    return { kind: "read-interactions" as const, threadId };
  if (
    method === SHARED_INTERACTIONS_RESPOND &&
    Object.keys(record(params)).length === 4 &&
    typeof interactionId === "string" &&
    interactionId.length > 0 &&
    interactionId.length <= 512 &&
    typeof submissionId === "string" &&
    submissionId.length > 0 &&
    submissionId.length <= 512 &&
    result &&
    typeof result === "object" &&
    !Array.isArray(result)
  )
    return { kind: "respond-interaction" as const, threadId, interactionId, submissionId, result: record(result) };
  return null;
}

function sideChatMode(model: string, effort: string | null) {
  return {
    mode: "default",
    settings: { model, reasoning_effort: effort, developer_instructions: SIDE_CHAT_INSTRUCTIONS },
  };
}

export const CODEX_TURN_STREAM_TYPE = "application/x-ndjson";
export type CodexResume = Extract<NonNullable<ReturnType<typeof parseCodexTurnOperation>>, { kind: "resume" }>;
export type CodexThreadMutation = Extract<
  NonNullable<ReturnType<typeof parseCodexTurnOperation>>,
  { kind: "thread-mutation" }
>;
type CodexSteer = Omit<Extract<NonNullable<ReturnType<typeof parseCodexTurnOperation>>, { kind: "steer" }>, "kind">;

export function parseCodexSteerReceipt(result: unknown, expectedTurnId: string) {
  return record(result).turnId === expectedTurnId ? { turnId: expectedTurnId } : null;
}

export function parseCodexThreadMutationReceipt(result: unknown, operation: CodexThreadMutation) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  if (operation.method !== "thread/unarchive") return Object.keys(result).length === 0 ? {} : null;
  const raw = record(result).thread;
  const thread = threadCatalogEntry(raw);
  return record(raw).ephemeral === false && thread?.id === operation.threadId ? { thread } : null;
}

export function isDefinitiveCodexSteerRefusal(error: unknown): boolean {
  return (
    error instanceof EndpointRpcError &&
    (error.code === -32601 ||
      error.code === -32602 ||
      (error.code === -32600 &&
        ([
          "no active turn to steer",
          "cannot steer a review turn",
          "cannot steer a compact turn",
          "active turn uses a different output schema",
        ].includes(error.message) ||
          /^expected active turn id `[^`]+` but found `[^`]+`$/u.test(error.message))))
  );
}

export function matchesCodexResume(result: unknown, resume: CodexResume): boolean {
  const response = record(result);
  const thread = record(response.thread);
  return (
    thread.id === resume.threadId &&
    thread.ephemeral === false &&
    Array.isArray(thread.turns) &&
    (resume.hints.path == null || resume.hints.path === thread.path) &&
    (resume.hints.cwd == null || resume.hints.cwd === response.cwd) &&
    (resume.hints.model == null || resume.hints.model === response.model) &&
    (resume.hints.modelProvider == null || resume.hints.modelProvider === response.modelProvider)
  );
}

export function parseCodexTurnOperationCall(value: unknown) {
  const packet = record(value);
  const attachment = parseClientAttachment(packet.attachment);
  const operation = typeof packet.method === "string" ? parseCodexTurnOperation(packet.method, packet.params) : null;
  const placement = parseThreadPlacementReceipt(packet.placement);
  return attachment && operation && placement?.state === "placed" && placement.threadId === operation.threadId
    ? { attachment, operation, placement }
    : null;
}

type NativeTurn = {
  readonly id: string;
  readonly status: string;
  readonly items: readonly [];
  readonly itemsView: "notLoaded";
  readonly error: null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly durationMs: number | null;
};
export type TurnStreamFrame =
  | { readonly kind: "accepted"; readonly result: { readonly turn: NativeTurn } }
  | { readonly kind: "event"; readonly frame: JsonRpcNotification }
  | { readonly kind: "refused"; readonly outcome: "denied" | "not-submitted" | "unknown" };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const finiteNumber = (input: unknown) => (typeof input === "number" && Number.isFinite(input) ? input : null);
const nativeTurn = (value: unknown): NativeTurn | null => {
  const { id, status, startedAt, completedAt, durationMs } = record(value);
  if (
    typeof id !== "string" ||
    !id ||
    id.length > 512 ||
    typeof status !== "string" ||
    !["inProgress", "completed", "failed", "interrupted"].includes(status)
  )
    return null;
  return {
    id,
    status,
    items: [],
    itemsView: "notLoaded",
    error: null,
    startedAt: finiteNumber(startedAt),
    completedAt: finiteNumber(completedAt),
    durationMs: finiteNumber(durationMs),
  };
};
const TERMINAL = ["completed", "failed", "interrupted"];

// Keep command output frames below the Turn stream byte budget even when
// every character needs JSON escaping. Native history keeps the full Item.
const TURN_STREAM_TEXT_LIMIT = 32 * 1024;
const boundedCommandText = (value: unknown, limit: number) =>
  typeof value === "string" ? value.slice(0, limit) : null;

function nativeCommandAction(value: unknown): CommandAction | null {
  const { type, command, name, path, query } = record(value);
  const text = boundedCommandText(command, 1024);
  if (text === null) return null;
  const actionPath = boundedCommandText(path, 1024);
  if (type === "read" && typeof name === "string" && actionPath !== null)
    return { type, command: text, name: name.slice(0, 1024), path: actionPath };
  if (type === "listFiles") return { type, command: text, path: actionPath };
  if (type === "search") return { type, command: text, path: actionPath, query: boundedCommandText(query, 1024) };
  return type === "unknown" ? { type, command: text } : null;
}

function nativeCommandItem(item: Record<string, unknown>): Extract<ThreadItem, { type: "commandExecution" }> | null {
  const { id, command, cwd, source, status, commandActions, aggregatedOutput, exitCode, durationMs } = item;
  if (
    typeof id !== "string" ||
    !id ||
    id.length > 512 ||
    typeof command !== "string" ||
    typeof cwd !== "string" ||
    (source !== "agent" &&
      source !== "userShell" &&
      source !== "unifiedExecStartup" &&
      source !== "unifiedExecInteraction") ||
    (status !== "inProgress" && status !== "completed" && status !== "failed" && status !== "declined")
  )
    return null;
  return {
    type: "commandExecution",
    id,
    command: command.slice(0, 16 * 1024),
    cwd: cwd.slice(0, 4096),
    processId: null,
    pluginId: null,
    scriptPath: null,
    source,
    status,
    commandActions: Array.isArray(commandActions)
      ? commandActions
          .slice(0, 8)
          .map(nativeCommandAction)
          .filter((action) => action !== null)
      : [],
    aggregatedOutput:
      typeof aggregatedOutput !== "string"
        ? null
        : aggregatedOutput.length <= TURN_STREAM_TEXT_LIMIT
          ? aggregatedOutput
          : "[output truncated]\n" + aggregatedOutput.slice(-TURN_STREAM_TEXT_LIMIT),
    exitCode: typeof exitCode === "number" && Number.isInteger(exitCode) ? exitCode : null,
    durationMs: finiteNumber(durationMs),
  };
}

const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function nativePlan(value: unknown): TurnPlanStep[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const plan: TurnPlanStep[] = [];
  for (const entry of value) {
    const { step, status } = record(entry);
    if (typeof step !== "string" || (status !== "pending" && status !== "inProgress" && status !== "completed"))
      return null;
    plan.push({ step: step.slice(0, 512), status });
  }
  return plan;
}

function nativeChanges(value: unknown): FileUpdateChange[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const changes: FileUpdateChange[] = [];
  let characters = 0;
  for (const entry of value) {
    const { path, kind, diff } = record(entry);
    const { type, move_path } = record(kind);
    if (typeof path !== "string" || !path || path.length > 4096 || typeof diff !== "string") return null;
    const destination = type === "update" ? (move_path ?? null) : null;
    if (destination !== null && (typeof destination !== "string" || destination.length > 4096)) return null;
    characters += path.length + diff.length + (destination?.length ?? 0);
    if (characters > TURN_STREAM_TEXT_LIMIT) return null;
    if (type === "add" || type === "delete") changes.push({ path, diff, kind: { type } });
    else if (type === "update") changes.push({ path, diff, kind: { type, move_path: destination } });
    else return null;
  }
  return changes;
}

function nativeReasoningParts(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const parts: string[] = [];
  let remaining = TURN_STREAM_TEXT_LIMIT;
  for (const part of value) {
    if (typeof part !== "string") return null;
    const text = part.slice(0, remaining);
    remaining -= text.length;
    parts.push(text);
  }
  return parts;
}

function nativeTokenUsage(value: unknown): ThreadTokenUsage | null {
  const counters = (value: unknown): TokenUsageBreakdown | null => {
    const {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens = 0,
      outputTokens,
      reasoningOutputTokens,
    } = record(value);
    if (
      !nonNegativeInteger(totalTokens) ||
      !nonNegativeInteger(inputTokens) ||
      !nonNegativeInteger(cachedInputTokens) ||
      !nonNegativeInteger(cacheWriteInputTokens) ||
      !nonNegativeInteger(outputTokens) ||
      !nonNegativeInteger(reasoningOutputTokens)
    )
      return null;
    return { totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens };
  };
  const { modelContextWindow, last, total } = record(value);
  const lastUsage = counters(last);
  const totalUsage = counters(total);
  if ((!nonNegativeInteger(modelContextWindow) && modelContextWindow !== null) || !lastUsage || !totalUsage)
    return null;
  return { modelContextWindow, last: lastUsage, total: totalUsage };
}

export function scopedCodexTurnEvent(value: unknown, threadId: string, turnId: string): JsonRpcNotification | null {
  const { method, params: raw, id } = record(value);
  const params = record(raw);
  if (id !== undefined || params.threadId !== threadId) return null;
  if (method === SHARED_INTERACTIONS_CHANGED) {
    const snapshot = parseSharedInteractionSnapshot(raw);
    return snapshot ? { method, params: snapshot } : null;
  }
  if (method === "turn/started" || method === "turn/completed") {
    const turn = nativeTurn(params.turn);
    if (turn?.id !== turnId || (method === "turn/completed" && !TERMINAL.includes(turn.status ?? ""))) return null;
    return { method, params: { threadId, turn } };
  }
  if (params.turnId !== turnId) return null;
  const turnScope = { threadId, turnId };
  if (method === "item/agentMessage/delta" && typeof params.itemId === "string" && typeof params.delta === "string")
    return { method, params: { ...turnScope, itemId: params.itemId, delta: params.delta } };
  if (method === "turn/plan/updated") {
    const plan = nativePlan(params.plan);
    if (plan)
      return { method, params: { ...turnScope, explanation: boundedCommandText(params.explanation, 4096), plan } };
    return null;
  }
  if (method === "thread/tokenUsage/updated") {
    const tokenUsage = nativeTokenUsage(params.tokenUsage);
    return tokenUsage ? { method, params: { ...turnScope, tokenUsage } } : null;
  }
  if (typeof params.itemId === "string" && params.itemId.length > 0 && params.itemId.length <= 512) {
    const scope = { ...turnScope, itemId: params.itemId };
    const delta = boundedCommandText(params.delta, TURN_STREAM_TEXT_LIMIT);
    if (method === "item/plan/delta") return delta === null ? null : { method, params: { ...scope, delta } };
    if (method === "item/commandExecution/outputDelta" && typeof params.delta === "string")
      return { method, params: { ...scope, delta: params.delta.slice(-TURN_STREAM_TEXT_LIMIT) } };
    if (method === "item/fileChange/patchUpdated") {
      const changes = nativeChanges(params.changes);
      return changes ? { method, params: { ...scope, changes } } : null;
    }
    const { summaryIndex, contentIndex } = params;
    if (nonNegativeInteger(summaryIndex) && summaryIndex < 128) {
      if (method === "item/reasoning/summaryPartAdded") return { method, params: { ...scope, summaryIndex } };
      if (method === "item/reasoning/summaryTextDelta" && delta !== null)
        return { method, params: { ...scope, summaryIndex, delta } };
    }
    if (
      method === "item/reasoning/textDelta" &&
      nonNegativeInteger(contentIndex) &&
      contentIndex < 128 &&
      delta !== null
    )
      return { method, params: { ...scope, contentIndex, delta } };
  }
  if (method !== "item/started" && method !== "item/completed") return null;
  const item = record(params.item);
  const clock = method === "item/started" ? "startedAtMs" : "completedAtMs";
  const timestamp = finiteNumber(params[clock]);
  const scope = { threadId, turnId, ...(timestamp === null ? {} : { [clock]: timestamp }) };
  if (item.type === "commandExecution") {
    const command = nativeCommandItem(item);
    return command === null ? null : { method, params: { ...scope, item: command } };
  }
  if (item.type === "userMessage" && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 512) {
    const content = parseTurnText(item.content);
    if (content)
      return {
        method,
        params: {
          ...scope,
          item: {
            type: "userMessage",
            id: item.id,
            clientId: isInputId(item.clientId) ? item.clientId : null,
            content,
          },
        },
      };
  }
  const { type, id: itemId, text, phase } = item;
  if (typeof itemId !== "string" || !itemId || itemId.length > 512) return null;
  if (type === "reasoning") {
    const summary = nativeReasoningParts(item.summary);
    const content = nativeReasoningParts(item.content);
    if (summary && content) return { method, params: { ...scope, item: { type, id: itemId, summary, content } } };
  }
  if (type === "fileChange") {
    const { status } = item;
    const changes = nativeChanges(item.changes);
    if (changes && (status === "inProgress" || status === "completed" || status === "failed" || status === "declined"))
      return { method, params: { ...scope, item: { type, id: itemId, changes, status } } };
  }
  if (type === "plan" && typeof text === "string")
    return { method, params: { ...scope, item: { type, id: itemId, text: text.slice(0, TURN_STREAM_TEXT_LIMIT) } } };
  if (type === "agentMessage" && typeof text === "string")
    return {
      method,
      params: { ...scope, item: { type, id: itemId, text, phase: typeof phase === "string" ? phase : null } },
    };
  return null;
}

export function parseTurnStreamFrame(value: unknown, threadId: string, turnId?: string): TurnStreamFrame | null {
  const packet = record(value);
  if (packet.kind === "accepted" && !turnId) {
    const result = record(packet.result);
    const turn = nativeTurn(result.turn);
    return turn ? { kind: "accepted", result: { turn } } : null;
  }
  if (packet.kind === "event" && turnId) {
    const frame = scopedCodexTurnEvent(packet.frame, threadId, turnId);
    return frame ? { kind: "event", frame } : null;
  }
  if (
    packet.kind === "refused" &&
    !turnId &&
    (packet.outcome === "denied" || packet.outcome === "not-submitted" || packet.outcome === "unknown")
  )
    return { kind: "refused", outcome: packet.outcome };
  return null;
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
};

type NativeLaneSocket = EndpointWebSocket & { readonly observation: { readonly incarnation: string } };
type NativeLaneMessage = JsonRpcIncomingMessage &
  Pick<InteractionSourceRequest, "__opencraftInteractionKey" | "__opencraftInteractionState">;
type InteractionReply = (source: InteractionSourceRequest, result: Record<string, unknown>) => Promise<void>;

export interface CodexTurnControls {
  interrupt(): Promise<void>;
  steer(params: CodexSteer, admit: () => Promise<void>): Promise<{ turnId: string }>;
  respond: InteractionReply;
  resume(excludeTurns: boolean): Promise<unknown>;
}

export interface NativeMutationLane {
  readonly engineIncarnation: string;
  readonly createdThreads: Map<string, unknown>;
  readonly closed: Promise<void>;
  request(method: string, params: unknown, signal?: AbortSignal, beforeSend?: () => Promise<void>): Promise<unknown>;
  respond: InteractionReply;
  subscribe(listener: (message: NativeLaneMessage, length: number) => void): () => void;
  close(): Promise<void>;
}

export function resumeNativeThread(
  channel: NativeMutationLane,
  threadId: string,
  excludeTurns: boolean,
  signal?: AbortSignal,
) {
  const created = channel.createdThreads.get(threadId);
  // A newly created Thread has no rollout for Native to resume. Its original
  // Native start receipt already describes the live Thread and empty history.
  if (created)
    return Promise.resolve({
      ...record(created),
      collaborationMode: null,
      initialTurnsPage: null,
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    });
  return channel.request("thread/resume", { threadId, excludeTurns, config: CODEX_WORKBENCH_THREAD_CONFIG }, signal);
}

/** Keeps Native's Thread subscriptions across browser connections and Turn calls. */
export async function openNativeMutationLane(
  open: (lane: string, onMessage: (frame: string) => void) => Promise<NativeLaneSocket>,
): Promise<NativeMutationLane> {
  const prefix = crypto.randomUUID();
  let sequence = 0;
  let ended = false;
  let listener: ((message: NativeLaneMessage, length: number) => void) | undefined;
  // The existing callback owner replays pending human requests as soon as it
  // receives `initialized`, before a recovering Turn can read its snapshot.
  let replay: { message: NativeLaneMessage; length: number }[] | undefined = [];
  let replaySize = 0;
  let pending: { id: string; reply: ReturnType<typeof deferred<unknown>> } | undefined;
  const socket = await open("workspace-mutation", (frame) => {
    if (!listener && !pending && !replay) return;
    try {
      const message = parseJsonRpcMessage(frame);
      if ("method" in message) {
        const human = isJsonRpcRequest(message) && isHumanInteraction(message.method, message.params);
        let projected: NativeLaneMessage = message;
        if (human && (listener || replay)) {
          const source = record(JSON.parse(frame));
          const key = source.__opencraftInteractionKey;
          const state = source.__opencraftInteractionState;
          projected = {
            ...message,
            ...(typeof key === "string" && key.length > 0 && key.length <= 512
              ? { __opencraftInteractionKey: key }
              : {}),
            ...(state === "pending" || state === "responding" || state === "unconfirmed"
              ? { __opencraftInteractionState: state }
              : {}),
          };
        }
        if (listener) listener(projected, frame.length);
        else if (
          replay &&
          (human || message.method === "serverRequest/resolved" || message.method === "turn/completed")
        ) {
          replaySize += frame.length;
          if (replaySize > 1024 * 1024 || replay.length >= 256) throw new Error("Native replay exceeds its budget");
          replay.push({ message: projected, length: frame.length });
        }
      } else if (pending && message.id === pending.id) {
        if (isJsonRpcSuccess(message)) pending.reply.resolve(message.result);
        else if (isJsonRpcFailure(message))
          pending.reply.reject(new EndpointRpcError(message.error.code, message.error.message));
      }
    } catch {
      void socket.close().catch(() => {});
    }
  });
  void socket.closed.then(() => {
    ended = true;
    pending?.reply.reject(new Error("Native mutation lane closed"));
  });
  const request = async (
    method: string,
    params: unknown,
    signal?: AbortSignal,
    beforeSend?: () => Promise<void>,
  ): Promise<unknown> => {
    if (ended || pending) throw new Error("Native mutation lane unavailable");
    signal?.throwIfAborted();
    const id = prefix + ":" + ++sequence;
    const reply = deferred<unknown>();
    void reply.promise.catch(() => {});
    pending = { id, reply };
    const abort = () => reply.reject(new Error("Native request cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (beforeSend) {
        await beforeSend();
        signal?.throwIfAborted();
        if (ended) throw new Error("Native mutation lane unavailable");
      }
      timeout = setTimeout(() => reply.reject(new Error("Native request outcome unknown")), 10_000);
      await socket.send(JSON.stringify({ id, method, params }));
      return await reply.promise;
    } finally {
      pending = undefined;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  };
  try {
    await request("initialize", {
      clientInfo: { name: "opencraft-workspace-owner", version: "1" },
      capabilities: { experimentalApi: true, extensions: { [OPENCRAFT_STEER_EVIDENCE_EXTENSION]: true } },
    });
    await socket.send('{"method":"initialized","params":{}}');
    return {
      engineIncarnation: socket.observation.incarnation,
      createdThreads: new Map(),
      closed: socket.closed,
      request,
      async respond(source, result) {
        if (ended) throw new Error("Native mutation lane unavailable");
        await socket.send(
          JSON.stringify({ id: source.id, result, __opencraftInteractionKey: source.__opencraftInteractionKey }),
        );
      },
      subscribe(accept) {
        listener = accept;
        const buffered = replay;
        replay = undefined;
        for (const entry of buffered ?? []) accept(entry.message, entry.length);
        return () => {
          listener = undefined;
        };
      },
      close: () => socket.close(),
    };
  } catch (error) {
    await socket.close().catch(() => {});
    throw error;
  }
}

/** A scoped Turn stream and native replies on the workspace's owning lane. */
export async function runCodexTurn(
  codex: WorkspaceCodex,
  call:
    | (CodexTurn & { readonly sideChat?: boolean })
    | { readonly threadId: string; readonly existing: { readonly turnId: string; readonly engineIncarnation: string } },
  signal: AbortSignal,
  admit: (engineIncarnation: string) => Promise<void>,
  publish: (frame: TurnStreamFrame) => void,
  controls?: {
    readonly interactions: HostInteractions;
    interactionSnapshot(): SharedInteractionSnapshot;
    expose(controls: CodexTurnControls): void;
    attached?(): void;
  },
): Promise<void> {
  return codex.withMutationLane(async (channel) => {
    const { threadId } = call;
    let collaborationMode: ReturnType<typeof sideChatMode> | undefined;
    if ("existing" in call) {
      if (call.existing.engineIncarnation !== channel.engineIncarnation)
        throw new Error("The original Codex process is unavailable");
    } else {
      // A Thread without a rollout is already subscribed on the lane that
      // created it. A persisted Thread uses the normal Native resume path.
      const response = channel.createdThreads.has(threadId)
        ? await channel.request("thread/read", { threadId, includeTurns: false }, signal)
        : await resumeNativeThread(channel, threadId, true, signal);
      const thread = record(record(response).thread);
      if (thread.id !== threadId || thread.ephemeral !== false || record(thread.status).type !== "idle")
        throw new Error("Native Thread is not idle");
      if (call.sideChat) {
        const settings = record(response);
        const model = call.model ?? settings.model;
        if (!isCodexModelId(model)) throw new Error("Side chat model unavailable");
        const effort = call.effort ?? settings.reasoningEffort;
        collaborationMode = sideChatMode(model, typeof effort === "string" ? effort : null);
      }
    }

    let turnId: string | undefined;
    let interrupting: Promise<void> | undefined;
    let steering: Promise<{ turnId: string }> | undefined;
    const early: NativeLaneMessage[] = [];
    let earlySize = 0;
    const done = deferred<void>();
    void done.promise.catch(() => {});
    const fail = () => done.reject(new Error("Native Turn stream closed"));
    const onEvent = (message: NativeLaneMessage) => {
      if (!turnId || !("method" in message) || message.method === SHARED_INTERACTIONS_CHANGED) return;
      const params = record(message.params);
      if (
        controls &&
        isJsonRpcRequest(message) &&
        params.turnId === turnId &&
        isHumanInteraction(message.method, params)
      ) {
        controls.interactions.capture({ ...message, params });
        return;
      }
      const requestId = params.requestId;
      if (
        message.method === "serverRequest/resolved" &&
        !("id" in message) &&
        (typeof requestId === "number" || typeof requestId === "string")
      )
        controls?.interactions.resolveNative(requestId, threadId);
      const frame = scopedCodexTurnEvent(message, threadId, turnId);
      if (!frame) return;
      if (frame.method === "turn/completed") controls?.interactions.resolveTurn(threadId, turnId);
      publish({ kind: "event", frame });
      if (frame.method === "turn/completed") {
        channel.createdThreads.delete(threadId);
        done.resolve();
      }
    };
    await admit(channel.engineIncarnation);
    signal.throwIfAborted();
    const retire = new AbortController();
    void channel.closed.then(() => {
      if (!retire.signal.aborted) fail();
    });
    signal.addEventListener("abort", fail, { once: true });
    const unsubscribeInteractions = controls?.interactions.subscribe((changedThread) => {
      if (changedThread === threadId && turnId)
        publish({
          kind: "event",
          frame: { method: SHARED_INTERACTIONS_CHANGED, params: controls.interactionSnapshot() },
        });
    });
    const stop = channel.subscribe((message, length) => {
      if (!("method" in message) || record(message.params).threadId !== threadId) return;
      try {
        if ("id" in message && length > 64 * 1024) throw new Error("Native interaction exceeds its frame budget");
        if (turnId) onEvent(message);
        else {
          earlySize += length;
          if (early.length >= 256 || earlySize > 1024 * 1024) throw new Error("Native Turn event queue exceeded");
          early.push(message);
        }
      } catch {
        fail();
      }
    });
    try {
      let turn: NativeTurn | null;
      if ("existing" in call) {
        const response = record(await channel.request("thread/read", { threadId, includeTurns: true }, signal));
        const thread = record(response.thread);
        const match =
          thread.id === threadId && thread.ephemeral === false && Array.isArray(thread.turns)
            ? thread.turns.find((item) => record(item).id === call.existing.turnId)
            : undefined;
        turn = nativeTurn(match);
      } else {
        const { sideChat: _sideChat, ...params } = call;
        const response = record(
          await channel.request("turn/start", collaborationMode ? { ...params, collaborationMode } : params, signal),
        );
        turn = nativeTurn(response.turn);
        if (turn) channel.createdThreads.delete(threadId);
      }
      if (!turn) throw new Error("Native Turn has no stable identity");
      turnId = turn.id;
      if (turn.status === "inProgress")
        controls?.expose({
          interrupt() {
            signal.throwIfAborted();
            return (interrupting ??= channel
              .request("turn/interrupt", { threadId, turnId: turn.id }, signal)
              .then((result) => {
                if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 0)
                  throw new Error("Invalid native interrupt receipt");
              }));
          },
          async steer(params, admit) {
            if (steering || params.threadId !== threadId || params.expectedTurnId !== turn.id)
              throw new Error("Native steer lane unavailable");
            steering = channel.request("turn/steer", params, signal, admit).then((result) => {
              const receipt = parseCodexSteerReceipt(result, turn.id);
              if (!receipt) throw new Error("Invalid native steer receipt");
              return receipt;
            });
            try {
              return await steering;
            } finally {
              steering = undefined;
            }
          },
          respond: channel.respond,
          resume: (excludeTurns) => resumeNativeThread(channel, threadId, excludeTurns, signal),
        });
      publish({ kind: "accepted", result: { turn } });
      for (const message of early) onEvent(message);
      if ("existing" in call && turn.status !== "inProgress")
        onEvent({ method: "turn/completed", params: { threadId, turn } });
      controls?.attached?.();
      await done.promise;
    } finally {
      unsubscribeInteractions?.();
      stop();
      signal.removeEventListener("abort", fail);
      retire.abort();
      // Native may emit the terminal event before the pending control receipt.
      await Promise.allSettled([interrupting, steering]);
    }
  });
}
