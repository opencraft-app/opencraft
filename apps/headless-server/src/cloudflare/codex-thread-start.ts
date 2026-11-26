import { isTerminalResourceScopeId, SIDE_CHAT_INSTRUCTIONS, type JsonRpcId } from "@opencraft/appserver-protocol";
import { isWorkspaceId } from "@opencraft/sandbox/uri";
import type { InstallationCoreNamespace } from "./bindings.js";
import { parseClientAttachment, type ClientAttachment } from "./client-attachment.js";
import { parseThreadPlacementReceipt, sameThreadPlacement, type ThreadPlacementReceipt } from "./thread-placement.js";
import { parseWorkspaceProjectAssignment, type WorkspaceProjectAssignment } from "./workspace-projects.js";

export const CODEX_THREAD_START_PATH = "/__opencraft_internal/codex-thread/start";
export const CODEX_THREAD_START_AUTHORITY_PATH = "/__opencraft_internal/codex-thread/start-authority";
export const CODEX_START_SPACE = "myself";
export const CODEX_THREAD_START_BODY_BYTES = 32 * 1024;

export const isCodexModelId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/u.test(value);

interface CodexNewThreadOptions extends Partial<WorkspaceProjectAssignment> {
  readonly model?: string;
  readonly historyMode?: "paginated";
  readonly draftScopeId?: string;
}

interface CodexFork {
  readonly threadId: string;
  readonly lastTurnId?: string;
  readonly beforeTurnId?: string;
  readonly sideChat?: { readonly intentId: string; readonly cwd?: string };
}

export type CodexStartOptions = CodexNewThreadOptions & { readonly fork?: CodexFork };

export interface CodexForkSource {
  readonly placement: ThreadPlacementReceipt;
  readonly spaceId: string;
  readonly policyRevision: number;
  readonly accessMode: "shared" | "private";
}

const identity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value);

/** The installation owns workspace admission; project coordinates are validated by its WorkspaceHost. */
function parseCodexStartOptions(params: unknown): CodexNewThreadOptions | null {
  if (params === undefined) return {};
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const value = params as Record<string, unknown>;
  const empty = (field: unknown) => field === undefined || (Array.isArray(field) && field.length === 0);
  const hasProject = value.projectId !== undefined;
  const project = hasProject ? parseWorkspaceProjectAssignment(value) : null;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "ephemeral",
          "historyMode",
          "runtimeWorkspaceRoots",
          "dynamicTools",
          "collaborationSpaceId",
          "model",
          "serviceTier",
          "draftScopeId",
          "projectId",
          "cwd",
        ].includes(key),
    ) ||
    (value.ephemeral !== undefined && value.ephemeral !== false) ||
    (value.historyMode !== undefined && value.historyMode !== "legacy" && value.historyMode !== "paginated") ||
    (value.collaborationSpaceId !== undefined && value.collaborationSpaceId !== CODEX_START_SPACE) ||
    !empty(value.dynamicTools) ||
    (hasProject ? !project : value.cwd !== undefined || !empty(value.runtimeWorkspaceRoots)) ||
    (value.model != null && !isCodexModelId(value.model)) ||
    // Native null inherits the default tier, matching turn/start.
    value.serviceTier != null ||
    (value.draftScopeId !== undefined && !isTerminalResourceScopeId(value.draftScopeId))
  )
    return null;
  return {
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(value.historyMode === "paginated" ? { historyMode: value.historyMode } : {}),
    ...(typeof value.draftScopeId === "string" ? { draftScopeId: value.draftScopeId } : {}),
    ...project,
  };
}

function parseCodexFork(params: unknown): CodexFork | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const fields = params as Record<string, unknown>;
  const { threadId, lastTurnId, beforeTurnId, sideChat } = fields;
  const side = sideChat as Partial<NonNullable<CodexFork["sideChat"]>> | null | undefined;
  if (
    !identity(threadId) ||
    (lastTurnId != null && !identity(lastTurnId)) ||
    (beforeTurnId != null && !identity(beforeTurnId)) ||
    (lastTurnId != null && beforeTurnId != null) ||
    Object.keys(fields).some((key) => !["threadId", "lastTurnId", "beforeTurnId", "sideChat"].includes(key))
  )
    return null;
  if (side === undefined)
    return {
      threadId,
      ...(lastTurnId == null ? {} : { lastTurnId }),
      ...(beforeTurnId == null ? {} : { beforeTurnId }),
    };
  if (
    !side ||
    typeof side !== "object" ||
    Array.isArray(side) ||
    !identity(side.intentId) ||
    (side.cwd !== undefined && !identity(side.cwd)) ||
    lastTurnId != null ||
    beforeTurnId != null ||
    Object.keys(side).some((key) => key !== "intentId" && key !== "cwd")
  )
    return null;
  return { threadId, sideChat: { intentId: side.intentId, ...(side.cwd === undefined ? {} : { cwd: side.cwd }) } };
}

function parseCodexForkOptions(params: unknown): CodexStartOptions | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const { excludeTurns, ephemeral, path, deferGoalContinuation, workspaceFork, cwd, developerInstructions, ...fields } =
    params as Record<string, unknown>;
  if (
    Object.hasOwn(fields, "sideChat") ||
    (excludeTurns !== undefined && excludeTurns !== true) ||
    (ephemeral !== undefined && ephemeral !== false) ||
    (path !== undefined && path !== null) ||
    (deferGoalContinuation !== undefined && deferGoalContinuation !== true)
  )
    return null;
  if (workspaceFork === undefined) {
    if (cwd !== undefined || developerInstructions !== undefined) return null;
    const fork = parseCodexFork(fields);
    return fork ? { fork } : null;
  }
  if (
    !workspaceFork ||
    typeof workspaceFork !== "object" ||
    Array.isArray(workspaceFork) ||
    Object.keys(workspaceFork).length !== 2 ||
    !("kind" in workspaceFork) ||
    workspaceFork.kind !== "side-chat" ||
    !("intentId" in workspaceFork) ||
    developerInstructions !== SIDE_CHAT_INSTRUCTIONS
  )
    return null;
  const fork = parseCodexFork({
    ...fields,
    sideChat: { intentId: workspaceFork.intentId, ...(cwd == null ? {} : { cwd }) },
  });
  return fork ? { fork } : null;
}

export function parseCodexStartRequest(
  value: unknown,
  method?: "thread/start" | "thread/fork",
): { attachment: ClientAttachment; requestId: JsonRpcId; options: CodexStartOptions } | null {
  const body = value as { attachment?: unknown; requestId?: unknown; options?: unknown } | null;
  const attachment = parseClientAttachment(body?.attachment);
  const requestId = body?.requestId;
  const candidate = body?.options as { fork?: unknown } | undefined;
  const fork = method === undefined && candidate?.fork !== undefined ? parseCodexFork(candidate.fork) : null;
  const options =
    method === "thread/fork"
      ? parseCodexForkOptions(candidate)
      : fork && candidate && Object.keys(candidate).length === 1
        ? { fork }
        : parseCodexStartOptions(candidate);
  if (
    !attachment ||
    !options ||
    !(
      (typeof requestId === "string" && requestId.length > 0 && requestId.length <= 1024) ||
      (typeof requestId === "number" && Number.isSafeInteger(requestId))
    )
  )
    return null;
  return { attachment, requestId, options };
}

/** Default-model legacy admissions were stored as a bare workspace ID. */
export function codexStartPin(workspace: string, options: CodexStartOptions, source?: CodexForkSource) {
  return options.model === undefined &&
    options.historyMode === undefined &&
    options.fork === undefined &&
    options.draftScopeId === undefined &&
    options.projectId === undefined
    ? workspace
    : { workspace, ...options, ...(source ? { source } : {}) };
}

export function matchesCodexStartPin(
  value: unknown,
  workspace: string,
  options: CodexStartOptions,
  source?: CodexForkSource,
): boolean {
  const expected = codexStartPin(workspace, options, source);
  if (typeof expected === "string") return value === expected;
  const pin = value as ({ workspace?: unknown; source?: unknown } & Partial<CodexStartOptions>) | null;
  return (
    pin?.workspace === workspace &&
    pin.model === options.model &&
    pin.historyMode === options.historyMode &&
    pin.draftScopeId === options.draftScopeId &&
    pin.projectId === options.projectId &&
    pin.cwd === options.cwd &&
    JSON.stringify(pin.runtimeWorkspaceRoots) === JSON.stringify(options.runtimeWorkspaceRoots) &&
    pin.fork?.threadId === options.fork?.threadId &&
    pin.fork?.lastTurnId === options.fork?.lastTurnId &&
    pin.fork?.beforeTurnId === options.fork?.beforeTurnId &&
    pin.fork?.sideChat?.intentId === options.fork?.sideChat?.intentId &&
    pin.fork?.sideChat?.cwd === options.fork?.sideChat?.cwd &&
    (source ? sameCodexForkSource(parseCodexForkSource(pin.source), source) : pin.source === undefined)
  );
}

export async function codexStartOperation(
  attachment: ClientAttachment,
  id: JsonRpcId,
  { draftScopeId, fork }: CodexStartOptions,
): Promise<string> {
  const key = fork?.sideChat
    ? ["side-chat", attachment.actorId, fork.threadId, fork.sideChat.intentId]
    : draftScopeId !== undefined
      ? ["draft-scope", attachment.actorId, draftScopeId]
      : [attachment.actorId, attachment.actorGeneration, attachment.loginDigest, attachment.clientInstanceId, id];
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(key)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseCodexForkSource(value: unknown): CodexForkSource | null {
  const source = value as Partial<CodexForkSource> | null;
  const placement = parseThreadPlacementReceipt(source?.placement);
  const { spaceId, policyRevision, accessMode } = source ?? {};
  return placement?.state === "placed" &&
    identity(spaceId) &&
    typeof policyRevision === "number" &&
    Number.isSafeInteger(policyRevision) &&
    policyRevision > 0 &&
    (accessMode === "shared" || accessMode === "private")
    ? { placement, spaceId, policyRevision, accessMode }
    : null;
}

function sameCodexForkSource(actual: CodexForkSource | null, expected: CodexForkSource): boolean {
  return (
    !!actual &&
    actual.spaceId === expected.spaceId &&
    actual.policyRevision === expected.policyRevision &&
    actual.accessMode === expected.accessMode &&
    sameThreadPlacement(actual.placement, expected.placement)
  );
}

export function parseCodexStartAuthority(value: unknown) {
  const body = value as { operation?: unknown; workspace?: unknown; source?: unknown } | null;
  const request = parseCodexStartRequest(value);
  const { operation, workspace } = body ?? {};
  if (!request || typeof operation !== "string" || !/^[0-9a-f]{64}$/u.test(operation) || !isWorkspaceId(workspace))
    return null;
  if (!request.options.fork)
    return body?.source === undefined ? { ...request, operation, workspace, source: undefined } : null;
  const source = parseCodexForkSource(body?.source);
  return source?.placement.threadId === request.options.fork.threadId && source.placement.workspaceId === workspace
    ? { ...request, operation, workspace, source }
    : null;
}

export type CodexStartAuthority = NonNullable<ReturnType<typeof parseCodexStartAuthority>>;

export async function currentCodexStart(
  installation: ReturnType<InstallationCoreNamespace["get"]>,
  authority: CodexStartAuthority,
): Promise<boolean> {
  const response = await installation.fetch(
    new Request(`https://installation.invalid${CODEX_THREAD_START_AUTHORITY_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(authority),
    }),
  );
  if (response.status !== 204) await response.body?.cancel();
  return response.status === 204;
}

export function createdCodexThreadId(result: unknown, sourceThreadId?: string): string | null {
  const thread = (result as { thread?: { id?: unknown; ephemeral?: unknown; forkedFromId?: unknown } } | null)?.thread;
  return identity(thread?.id) &&
    thread.ephemeral === false &&
    (sourceThreadId === undefined || (thread.id !== sourceThreadId && thread.forkedFromId === sourceThreadId))
    ? thread.id
    : null;
}
