import type {
  AgentWorkDetailTypeWire,
  AgentWorkFileDetailTypeWire,
  AgentWorkGenericDetailTypeWire,
  AgentWorkSearchModeWire,
  AgentWorkDetailWire,
  AgentConfigPatchWire,
  ArchiveSessionWireResponse,
  AgentConfigWire,
  AgentRequestTypeWire,
  AgentRequestWire,
  BackendCapabilitiesWire,
  BackendFeatureBaseWire,
  BackendFeatureWire,
  BackendKindWire,
  BackendLocationKindWire,
  BackendLocationWire,
  BackendModelWire,
  BackendProbeResultWire,
  BackendSettingsPatchWire,
  BackendSettingsWireResponse,
  BackendStatusWire,
  BackendUsageLimitWire,
  BackendUsageLineWire,
  BackendUsageProfileWire,
  BackendUsageStatusWire,
  BackendUsageSummaryWire,
  BackendUsageToneWire,
  BackendUsageWireResponse,
  BackendWire,
  BackendWireResponse,
  BackendsWireResponse,
  ClientInputEvent,
  ClientInputPart,
  CommandAckWire,
  CommandRejectionCodeWire,
  ConversationItemKindWire,
  ConversationItemStatusWire,
  ConversationWindow,
  ConversationWindowOptions,
  ConversationWireItem,
  ConversationWireView,
  CreateSessionInput,
  CreateSessionWireResponse,
  CursorWindow,
  DiffReviewWireView,
  DiffSummaryStatusWire,
  DiffSummaryWire,
  EventCursorWire,
  MessagePartTypeWire,
  MessagePartWire,
  PendingRequestsOptions,
  PendingRequestsWireView,
  PermissionModeOptionWire,
  PermissionModeWire,
  ReasoningEffortOptionWire,
  RequestStatusWire,
  SessionListOptions,
  SessionListItemWire,
  SessionListViewWireResponse,
  SessionListWireResponse,
  SessionActivityAttentionWire,
  SessionActivityPhaseWire,
  SessionActivityWire,
  SessionSummaryWire,
  SessionOperationWire,
  SessionRuntimeInfoWire,
  SessionStatusWire,
  SessionWire,
  SessionWireResponse,
  UpdateAgentConfigWireResponse,
} from "./wire";
import { VeladClientError } from "./errors";
import { isRecord } from "./guards";

export function validateOptionalIdempotencyKey(idempotencyKey: unknown) {
  if (idempotencyKey === undefined) return undefined;
  if (typeof idempotencyKey !== "string") {
    throw invalidIdempotencyKey("Idempotency-Key must be a string");
  }
  return idempotencyKey;
}

export function encodeSessionId(sessionId: unknown) {
  if (typeof sessionId !== "string") {
    throw invalidSessionId("session_id must be a string");
  }
  return encodeURIComponent(sessionId);
}

export function validateAfterId(afterId: string | null | undefined) {
  if (afterId === undefined || afterId === null) return undefined;
  if (typeof afterId !== "string") {
    throw invalidAfterId("after_id must be a string");
  }
  return afterId;
}

export function validateSessionListOptions(options: SessionListOptions | undefined) {
  if (options === undefined) return;
  if (!isRecord(options)) {
    throw invalidSessionResponse("SessionListOptions must be an object");
  }
  const limit = options.limit;
  if (limit !== undefined && typeof limit !== "number") {
    throw invalidSessionResponse("SessionListOptions.limit must be a number");
  }
  validateViewWindowLimit(limit, "invalid_session_response");
  const afterId = options.afterId;
  if (afterId !== undefined && typeof afterId !== "string") {
    throw invalidSessionResponse("SessionListOptions.afterId must be a string");
  }
  validateOptionalViewWindowString(afterId, "afterId", "invalid_session_response");
}

export function encodeBackendKind(backend: unknown) {
  if (typeof backend !== "string" || !backendKinds.has(backend)) {
    throw invalidBackendKind("backend must be a known BackendKind");
  }
  return encodeURIComponent(backend);
}

const backendKinds = new Set<string>(
  [
    "vela_engine",
    "codex",
    "cloudagent",
    "claude_code",
    "pi",
    "opencode",
    "acp",
    "qoder",
  ] satisfies BackendKindWire[],
);

export function validateCreateSessionInput(input: unknown): asserts input is CreateSessionInput {
  if (!isRecord(input)) {
    throw invalidCreateSessionRequest("CreateSessionRequest must be an object");
  }

  const workingDirectory = input.workingDirectory;
  if (typeof workingDirectory !== "string") {
    throw invalidCreateSessionRequest("CreateSessionRequest requires working_directory");
  }

  const backend = input.backend;
  if (typeof backend !== "string" || !backendKinds.has(backend)) {
    throw invalidCreateSessionRequest("CreateSessionRequest backend must be a known BackendKind");
  }

  validateOptionalCreateSessionString(input, "title");
  validateOptionalCreateSessionString(input, "model");

  if (input.metadata !== undefined && !isRecord(input.metadata)) {
    throw invalidCreateSessionRequest("CreateSessionRequest metadata must be an object");
  }

  if (input.agentConfig !== undefined) {
    validateAgentConfigShape(input.agentConfig, invalidCreateSessionRequest, "CreateSessionRequest.agent_config");
  }
}

function validateOptionalCreateSessionString(input: Record<string, unknown>, field: string) {
  if (input[field] !== undefined && typeof input[field] !== "string") {
    throw invalidCreateSessionRequest(`CreateSessionRequest ${field} must be a string`);
  }
}

const agentConfigPatchKeys = new Set([
  "model",
  "reasoning_effort",
  "permission_mode",
  "feature_values",
]);

const permissionModes = new Set(["read_only", "auto", "auto_review", "full_access"]);
const viewWindowDirections = new Set(["tail", "before", "after", "around"]);
const backendStatuses = new Set(["loading", "available", "unavailable", "degraded", "error"]);
const backendLocationKinds = new Set(["local", "remote"]);
const sessionActivityPhases = new Set<string>(
  ["idle", "starting", "running", "canceling"] satisfies SessionActivityPhaseWire[],
);
const sessionActivityAttentions = new Set<string>(
  ["none", "waiting_for_user", "error"] satisfies SessionActivityAttentionWire[],
);
const sessionStatuses = new Set<string>(
  [
    "starting",
    "idle",
    "running",
    "waiting_for_input",
    "canceling",
    "failed",
    "closed",
    "archived",
  ] satisfies SessionStatusWire[],
);
const conversationItemKinds = new Set<string>(
  ["user_message", "assistant_message", "turn_meta", "agent_work", "status"] satisfies ConversationItemKindWire[],
);
const conversationItemStatuses = new Set<string>(
  ["pending", "running", "streaming", "completed", "failed", "cancelled"] satisfies ConversationItemStatusWire[],
);
const messagePartTypes = new Set<string>(
  ["text", "image", "file_reference"] satisfies MessagePartTypeWire[],
);
const requestTypes = new Set<string>(
  [
    "permission",
    "question",
    "tool_call",
    "tool_confirmation",
    "custom_input",
    "other",
  ] satisfies AgentRequestTypeWire[],
);
const requestStatuses = new Set<string>(
  [
    "pending",
    "approved",
    "denied",
    "answered",
    "expired",
    "cancelled",
  ] satisfies RequestStatusWire[],
);
const diffSummaryStatuses = new Set(["added", "modified", "deleted", "renamed"]);
const agentWorkSearchModes = new Set<AgentWorkSearchModeWire>(
  ["code", "web", "files", "unknown"] satisfies AgentWorkSearchModeWire[],
);
const agentWorkDetailTypes = new Set<string>(
  [
    "shell",
    "read",
    "edit",
    "write",
    "search",
    "fetch",
    "browser",
    "mcp_tool",
    "dynamic_tool",
    "sub_agent",
    "image_generation",
    "image_view",
    "plan",
    "plain_text",
    "unknown",
    "tool",
  ] satisfies AgentWorkDetailTypeWire[],
);
const backendCapabilityFields = [
  "streaming",
  "cancel",
  "permission_requests",
  "structured_diff",
  "session_agent_config",
];
const backendUsageStatuses = new Set(["ok", "needs_auth", "unsupported", "error"]);
const backendUsageTones = new Set(["ok", "warning", "critical", "neutral"]);

export function validateAgentConfigPatch(patch: unknown): asserts patch is AgentConfigPatchWire {
  if (!isRecord(patch)) {
    throw invalidAgentConfigPatch("AgentConfig patch must be an object");
  }

  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw invalidAgentConfigPatch("AgentConfig patch requires at least one field");
  }

  validateAgentConfigShape(patch, invalidAgentConfigPatch, "AgentConfig patch");
}

function validateAgentConfigShape(
  config: unknown,
  invalid: ViewContractErrorFactory,
  owner: string,
): asserts config is AgentConfigWire {
  if (!isRecord(config)) {
    throw invalid(`${owner} must be an object`);
  }

  const keys = Object.keys(config);
  for (const key of keys) {
    if (!agentConfigPatchKeys.has(key)) {
      throw invalid(`${owner} does not support ${key}`);
    }
    if (config[key] === undefined) {
      throw invalid(`${owner} ${key} must not be undefined`);
    }
    validateAgentConfigValue(key, config[key], invalid, owner);
  }
}

function validateAgentConfigValue(
  key: string,
  value: unknown,
  invalid: ViewContractErrorFactory,
  owner: string,
) {
  switch (key) {
    case "model":
    case "reasoning_effort":
      if (typeof value !== "string") {
        throw invalid(`${owner} ${key} must be a string`);
      }
      return;
    case "permission_mode":
      if (typeof value !== "string" || !permissionModes.has(value)) {
        throw invalid(
          `${owner} permission_mode must be read_only, auto, auto_review, or full_access`,
        );
      }
      return;
    case "feature_values":
      if (!isRecord(value)) {
        throw invalid(`${owner} feature_values must be an object`);
      }
      return;
  }
}

function parseSessionRuntimeInfoWire(
  runtimeInfo: unknown,
  invalid: ViewContractErrorFactory,
  owner: string,
): SessionRuntimeInfoWire {
  if (!isRecord(runtimeInfo)) {
    throw invalid(`${owner} must be an object`);
  }

  const provider = runtimeInfo.provider;
  if (typeof provider !== "string" || !backendKinds.has(provider)) {
    throw invalid(`${owner}.provider must be a known BackendKind`);
  }

  validateOptionalNullableSessionString(runtimeInfo, "native_session_id", invalid, owner);
  validateOptionalNullableSessionString(runtimeInfo, "model", invalid, owner);
  validateOptionalNullableSessionString(runtimeInfo, "reasoning_effort", invalid, owner);

  const permissionMode = runtimeInfo.permission_mode;
  if (
    permissionMode !== undefined &&
    permissionMode !== null &&
    (typeof permissionMode !== "string" || !permissionModes.has(permissionMode))
  ) {
    throw invalid(
      `${owner}.permission_mode must be read_only, auto, auto_review, or full_access`,
    );
  }

  const featureValues = runtimeInfo.feature_values;
  if (featureValues !== undefined && !isRecord(featureValues)) {
    throw invalid(`${owner}.feature_values must be an object`);
  }

  return {
    ...(runtimeInfo as unknown as SessionRuntimeInfoWire),
    provider: provider as BackendKindWire,
  };
}

function validateOptionalNullableSessionString(
  data: Record<string, unknown>,
  field: string,
  invalid: ViewContractErrorFactory,
  owner: string,
) {
  const value = data[field];
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw invalid(`${owner}.${field} must be a string or null`);
  }
}

function validateSessionOperationsShape(
  operations: unknown,
  invalid: ViewContractErrorFactory,
  owner: string,
): asserts operations is Record<string, SessionOperationWire | undefined> {
  if (!isRecord(operations)) {
    throw invalid(`${owner} must be an object`);
  }

  for (const [key, operation] of Object.entries(operations)) {
    const operationOwner = `${owner}.${key}`;
    if (!isRecord(operation)) {
      throw invalid(`${operationOwner} must be an object`);
    }
    if (typeof operation.available !== "boolean") {
      throw invalid(`${operationOwner}.available must be a boolean`);
    }
    if (
      operation.reason !== undefined &&
      operation.reason !== null &&
      typeof operation.reason !== "string"
    ) {
      throw invalid(`${operationOwner}.reason must be a string or null`);
    }
    if (
      operation.effective_after !== undefined &&
      operation.effective_after !== "current_session" &&
      operation.effective_after !== "next_turn"
    ) {
      throw invalid(`${operationOwner}.effective_after must be current_session or next_turn`);
    }
  }
}

function validateClientInputParts(parts: readonly ClientInputPart[]) {
  if (!Array.isArray(parts)) {
    throw invalidInputPart("InputPart content must be an array");
  }
  for (const part of parts) {
    validateClientInputPart(part);
  }
}

export function validateClientInputEvents(events: readonly ClientInputEvent[]) {
  if (!Array.isArray(events) || events.length === 0) {
    throw invalidInputEvent("SendSessionEventsRequest.events requires at least one event");
  }
  for (const event of events) {
    validateClientInputEvent(event);
  }
}

export function validateSendSessionEventsOptions(options: unknown) {
  if (options !== undefined && !isRecord(options)) {
    throw invalidInputEvent("SendSessionEventsRequest.options must be an object");
  }
}

function validateClientInputEvent(event: unknown): asserts event is ClientInputEvent {
  if (!isRecord(event)) {
    throw invalidInputEvent("ClientInputEvent must be an object");
  }
  validateOptionalInputEventOptions(event);
  switch (event.type) {
    case "user.message":
      validateClientInputParts(event.content as ClientInputPart[]);
      return;
    case "user.tool_confirmation":
      requireInputEventString(event, "request_id");
      requireInputEventEnum(event, "result", toolConfirmationResults);
      if (event.scope !== undefined) {
        requireInputEventEnum(event, "scope", toolConfirmationScopes);
      }
      return;
    case "user.custom_tool_result":
      requireInputEventString(event, "request_id");
      validateClientInputParts(event.content as ClientInputPart[]);
      return;
    case "user.request_answer":
      requireInputEventString(event, "request_id");
      requireInputEventString(event, "answer");
      return;
    default:
      throw invalidInputEvent(
        "ClientInputEvent.type must be user.message, user.tool_confirmation, user.custom_tool_result, or user.request_answer",
      );
  }
}

function validateClientInputPart(part: unknown): asserts part is ClientInputPart {
  if (!isRecord(part)) {
    throw invalidInputPart("InputPart must be an object");
  }
  switch (part.type) {
    case "text":
      requireInputPartString(part, "text");
      return;
    case "file_ref":
    case "image_ref":
      requireInputPartString(part, "uri");
      return;
    case "image":
      requireInputPartString(part, "data");
      requireInputPartString(part, "mime_type");
      return;
    default:
      throw invalidInputPart("InputPart.type must be text, file_ref, image_ref, or image");
  }
}

const toolConfirmationResults = new Set(["allow", "deny"]);
const toolConfirmationScopes = new Set(["once", "session", "project"]);

function requireInputEventString(event: Record<string, unknown>, field: string) {
  if (typeof event[field] !== "string") {
    throw invalidInputEvent(`ClientInputEvent.${String(event.type)} requires ${field}`);
  }
}

function requireInputEventEnum(
  event: Record<string, unknown>,
  field: string,
  values: Set<string>,
) {
  const value = event[field];
  if (typeof value !== "string" || !values.has(value)) {
    throw invalidInputEvent(`ClientInputEvent.${String(event.type)} ${field} must be a known value`);
  }
}

function validateOptionalInputEventOptions(event: Record<string, unknown>) {
  if (event.options !== undefined && !isRecord(event.options)) {
    throw invalidInputEvent(`ClientInputEvent.${String(event.type)} options must be an object`);
  }
}

function requireInputPartString(part: Record<string, unknown>, field: string) {
  if (typeof part[field] !== "string") {
    throw invalidInputPart(`InputPart.${String(part.type)} requires ${field}`);
  }
}

export function validateConversationWindowOptions(options: ConversationWindowOptions | undefined) {
  validateViewWindowLimit(options?.limit, "invalid_conversation_window_options");
  validateViewWindowDirection(options?.direction, "invalid_conversation_window_options");
  validateOptionalViewWindowString(
    options?.anchorItemId,
    "anchorItemId",
    "invalid_conversation_window_options",
  );
  if (!options?.direction) {
    if (options?.anchorItemId) {
      throw new VeladClientError(
        "invalid_conversation_window_options",
        "anchorItemId requires direction",
      );
    }
    return;
  }
  if (options.direction === "tail") {
    if (options.anchorItemId) {
      throw new VeladClientError(
        "invalid_conversation_window_options",
        "direction=tail cannot include anchorItemId",
      );
    }
    return;
  }
  if (!options.anchorItemId) {
    throw new VeladClientError(
      "invalid_conversation_window_options",
      `anchorItemId is required when direction=${options.direction}`,
    );
  }
}

export function validatePendingRequestsOptions(options: PendingRequestsOptions | undefined) {
  if (options?.status !== undefined && !requestStatuses.has(options.status)) {
    throw new VeladClientError(
      "invalid_pending_requests_options",
      "PendingRequestsView status must be pending, approved, denied, answered, expired, or cancelled",
    );
  }
}

function validateViewWindowDirection(direction: string | undefined, code: string) {
  if (direction === undefined) return;
  if (typeof direction !== "string" || !viewWindowDirections.has(direction)) {
    throw new VeladClientError(code, "direction must be tail, before, after, or around");
  }
}

function validateOptionalViewWindowString(value: string | undefined, field: string, code: string) {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new VeladClientError(code, `${field} must be a string`);
  }
}

function validateViewWindowLimit(limit: number | undefined, code: string) {
  if (limit === undefined) return;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new VeladClientError(code, "limit must be an integer between 1 and 500");
  }
}

export function normalizeBaseUrl(baseUrl: string) {
  const withSlash = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(withSlash)) {
    return withSlash;
  }

  const origin =
    typeof window !== "undefined" && typeof window.location?.origin === "string"
      ? window.location.origin
      : "http://localhost";
  return new URL(withSlash, origin).toString();
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      typeof data?.error?.message === "string"
        ? data.error.message
        : `velad request failed with ${response.status}`;
    throw new VeladClientError("velad_request_failed", message, data);
  }
  return data as T;
}

export async function readCreateSessionResponse(response: Response): Promise<CreateSessionWireResponse> {
  return parseCreateSessionWireResponse(await readJsonResponse<unknown>(response));
}

export function parseCreateSessionWireResponse(data: unknown): CreateSessionWireResponse {
  if (!isRecord(data)) {
    throw invalidCreateSessionResponse("CreateSessionResponse must be an object");
  }
  return {
    session: requiredSessionObject(data, "CreateSessionResponse", invalidCreateSessionResponse),
    cursor: requiredViewEventCursor(data, "cursor", "CreateSessionResponse", invalidCreateSessionResponse),
  };
}

export async function readUpdateAgentConfigResponse(
  response: Response,
): Promise<UpdateAgentConfigWireResponse> {
  return parseUpdateAgentConfigWireResponse(await readJsonResponse<unknown>(response));
}

export function parseUpdateAgentConfigWireResponse(
  data: unknown,
): UpdateAgentConfigWireResponse {
  if (!isRecord(data)) {
    throw invalidUpdateAgentConfigResponse("UpdateAgentConfigResponse must be an object");
  }
  return {
    session: requiredSessionObject(
      data,
      "UpdateAgentConfigResponse",
      invalidUpdateAgentConfigResponse,
    ),
    effective_after: requiredEffectiveAfter(data),
    cursor: requiredViewEventCursor(
      data,
      "cursor",
      "UpdateAgentConfigResponse",
      invalidUpdateAgentConfigResponse,
    ),
  };
}

export async function readSessionResponse(response: Response): Promise<SessionWireResponse> {
  return parseSessionWireResponse(await readJsonResponse<unknown>(response));
}

export async function readArchiveSessionResponse(
  response: Response,
): Promise<ArchiveSessionWireResponse> {
  return parseSessionWireResponse(await readJsonResponse<unknown>(response));
}

export async function readSessionListResponse(response: Response): Promise<SessionListWireResponse> {
  return parseSessionListWireResponse(await readJsonResponse<unknown>(response));
}

export async function readSessionListViewResponse(response: Response): Promise<SessionListViewWireResponse> {
  return parseSessionListViewWireResponse(await readJsonResponse<unknown>(response));
}

export function parseSessionWireResponse(data: unknown): SessionWireResponse {
  if (!isRecord(data)) {
    throw invalidSessionResponse("SessionResponse must be an object");
  }
  return {
    session: requiredSessionObject(data, "SessionResponse", invalidSessionResponse),
  };
}

export function parseSessionListWireResponse(data: unknown): SessionListWireResponse {
  if (!isRecord(data)) {
    throw invalidSessionResponse("SessionListResponse must be an object");
  }
  const sessions = requiredViewArray(
    data,
    "sessions",
    "SessionListResponse",
    invalidSessionResponse,
  );
  return {
    sessions: sessions.map((session, index) =>
      parseSessionSummaryWire(session, `SessionListResponse.sessions[${index}]`, invalidSessionResponse),
    ),
    cursor: requiredCursorWindow(data, "cursor", "SessionListResponse", invalidSessionResponse),
  };
}

export function parseSessionListViewWireResponse(data: unknown): SessionListViewWireResponse {
  if (!isRecord(data)) {
    throw invalidSessionResponse("SessionListView must be an object");
  }
  const sessions = requiredViewArray(
    data,
    "sessions",
    "SessionListView",
    invalidSessionResponse,
  );
  return {
    sessions: sessions.map((session, index) =>
      parseSessionListItemWire(session, `SessionListView.sessions[${index}]`, invalidSessionResponse),
    ),
    cursor: requiredCursorWindow(data, "cursor", "SessionListView", invalidSessionResponse),
  };
}

export async function readBackendsResponse(response: Response): Promise<BackendsWireResponse> {
  return parseBackendsWireResponse(await readJsonResponse<unknown>(response));
}

export function parseBackendsWireResponse(data: unknown): BackendsWireResponse {
  if (!isRecord(data)) {
    throw invalidBackendsResponse("BackendsResponse must be an object");
  }
  const backends = requiredViewArray(
    data,
    "backends",
    "BackendsResponse",
    invalidBackendsResponse,
  );
  return {
    backends: backends.map((backend, index) =>
      parseBackendWire(backend, `BackendsResponse.backends[${index}]`),
    ),
  };
}

export async function readBackendResponse(response: Response): Promise<BackendWireResponse> {
  return parseBackendWireResponse(await readJsonResponse<unknown>(response));
}

export function parseBackendWireResponse(data: unknown): BackendWireResponse {
  if (!isRecord(data)) {
    throw invalidBackendsResponse("BackendResponse must be an object");
  }
  const backend = data.backend;
  if (!isRecord(backend)) {
    throw invalidBackendsResponse("BackendResponse requires backend");
  }
  return {
    backend: parseBackendWire(backend, "BackendResponse.backend"),
  };
}

export async function readBackendUsageResponse(
  response: Response,
): Promise<BackendUsageWireResponse> {
  return parseBackendUsageWireResponse(await readJsonResponse<unknown>(response));
}

export function parseBackendUsageWireResponse(data: unknown): BackendUsageWireResponse {
  if (!isRecord(data)) {
    throw invalidBackendsResponse("BackendUsageResponse must be an object");
  }
  const schema = requiredBackendString(data, "schema", "BackendUsageResponse");
  if (schema !== "velad.backend_usage.v1") {
    throw invalidBackendsResponse("BackendUsageResponse.schema must be velad.backend_usage.v1");
  }
  const backend = requiredBackendKind(data, "backend", "BackendUsageResponse");
  const backendType = requiredBackendKind(data, "backend_type", "BackendUsageResponse");
  const status = requiredBackendUsageStatus(data, "status", "BackendUsageResponse");
  return {
    schema,
    backend,
    backend_type: backendType,
    status,
    source: requiredBackendString(data, "source", "BackendUsageResponse"),
    fetched_at: requiredBackendString(data, "fetched_at", "BackendUsageResponse"),
    ...(data.plan_name !== undefined
      ? { plan_name: optionalBackendString(data, "plan_name", "BackendUsageResponse") }
      : {}),
    ...(data.summary !== undefined
      ? {
          summary: parseBackendUsageSummary(
            data.summary,
            "BackendUsageResponse.summary",
          ),
        }
      : {}),
    limits: optionalBackendArray(data, "limits", "BackendUsageResponse").map((limit, index) =>
      parseBackendUsageLimit(limit, `BackendUsageResponse.limits[${index}]`),
    ),
    usage_lines: optionalBackendArray(data, "usage_lines", "BackendUsageResponse").map(
      (line, index) => parseBackendUsageLine(line, `BackendUsageResponse.usage_lines[${index}]`),
    ),
    profiles: optionalBackendArray(data, "profiles", "BackendUsageResponse").map(
      (profile, index) => parseBackendUsageProfile(profile, `BackendUsageResponse.profiles[${index}]`),
    ),
    ...(data.detail !== undefined
      ? { detail: optionalBackendString(data, "detail", "BackendUsageResponse") }
      : {}),
  };
}

function parseBackendUsageProfile(data: unknown, owner: string): BackendUsageProfileWire {
  if (!isRecord(data)) {
    throw invalidBackendsResponse(`${owner} must be an object`);
  }
  return {
    profile_id: requiredBackendString(data, "profile_id", owner),
    display_name: requiredBackendString(data, "display_name", owner),
    status: requiredBackendUsageStatus(data, "status", owner),
    source: requiredBackendString(data, "source", owner),
    ...(data.summary !== undefined
      ? { summary: parseBackendUsageSummary(data.summary, `${owner}.summary`) }
      : {}),
    limits: optionalBackendArray(data, "limits", owner).map((limit, index) =>
      parseBackendUsageLimit(limit, `${owner}.limits[${index}]`),
    ),
    usage_lines: optionalBackendArray(data, "usage_lines", owner).map((line, index) =>
      parseBackendUsageLine(line, `${owner}.usage_lines[${index}]`),
    ),
    ...(data.detail !== undefined ? { detail: optionalBackendString(data, "detail", owner) } : {}),
  };
}

function parseBackendUsageSummary(data: unknown, owner: string): BackendUsageSummaryWire {
  if (!isRecord(data)) {
    throw invalidBackendsResponse(`${owner} must be an object`);
  }
  const tone = requiredBackendString(data, "tone", owner);
  if (!backendUsageTones.has(tone)) {
    throw invalidBackendsResponse(`${owner}.tone must be ok, warning, critical, or neutral`);
  }
  return {
    label: requiredBackendString(data, "label", owner),
    tone: tone as BackendUsageToneWire,
  };
}

function parseBackendUsageLimit(data: unknown, owner: string): BackendUsageLimitWire {
  if (!isRecord(data)) {
    throw invalidBackendsResponse(`${owner} must be an object`);
  }
  return {
    kind: requiredBackendString(data, "kind", owner),
    label: requiredBackendString(data, "label", owner),
    ...(data.used_percent !== undefined
      ? { used_percent: optionalBackendNumber(data, "used_percent", owner) }
      : {}),
    ...(data.remaining_percent !== undefined
      ? { remaining_percent: optionalBackendNumber(data, "remaining_percent", owner) }
      : {}),
    ...(data.resets_at !== undefined
      ? { resets_at: optionalBackendString(data, "resets_at", owner) }
      : {}),
    ...(data.window_duration_mins !== undefined
      ? { window_duration_mins: optionalBackendNumber(data, "window_duration_mins", owner) }
      : {}),
  };
}

function parseBackendUsageLine(data: unknown, owner: string): BackendUsageLineWire {
  if (!isRecord(data)) {
    throw invalidBackendsResponse(`${owner} must be an object`);
  }
  return {
    label: requiredBackendString(data, "label", owner),
    value: requiredBackendString(data, "value", owner),
    ...(data.subtitle !== undefined ? { subtitle: optionalBackendString(data, "subtitle", owner) } : {}),
  };
}

function parseBackendWire(data: unknown, owner: string): BackendWire {
  if (!isRecord(data)) {
    throw invalidBackendsResponse(`${owner} must be an object`);
  }
  const kind = requiredViewString(data, "kind", owner, invalidBackendsResponse);
  if (!backendKinds.has(kind)) {
    throw invalidBackendsResponse(`${owner}.kind must be a known BackendKind`);
  }
  const status = requiredViewString(data, "status", owner, invalidBackendsResponse);
  if (!backendStatuses.has(status)) {
    throw invalidBackendsResponse(
      `${owner}.status must be loading, available, unavailable, degraded, or error`,
    );
  }
  return {
    kind: kind as BackendKindWire,
    ...(data.backend_type !== undefined
      ? {
          backend_type: requiredBackendKind(data, "backend_type", owner),
        }
      : {}),
    status: status as BackendStatusWire,
    ...(data.status_message !== undefined
      ? {
          status_message: optionalBackendString(data, "status_message", owner),
        }
      : {}),
    display_name: requiredViewString(data, "display_name", owner, invalidBackendsResponse),
    location: parseBackendLocationWire(data.location, `${owner}.location`),
    capabilities: requiredBackendCapabilities(data, owner),
    models: optionalBackendArray(data, "models", owner).map((model, index) =>
      parseBackendModelWire(model, `${owner}.models[${index}]`),
    ),
    permission_modes: optionalBackendArray(data, "permission_modes", owner).map((mode, index) =>
      parsePermissionModeOptionWire(mode, `${owner}.permission_modes[${index}]`),
    ),
    features: optionalBackendArray(data, "features", owner).map((feature, index) =>
      parseBackendFeatureWire(feature, `${owner}.features[${index}]`),
    ),
    ...(data.diagnostics !== undefined
      ? { diagnostics: optionalBackendObject(data, "diagnostics", owner) }
      : {}),
    ...(data.snapshot_protocol !== undefined
      ? {
          snapshot_protocol: optionalBackendString(data, "snapshot_protocol", owner),
        }
      : {}),
    ...(data.fetched_at !== undefined
      ? { fetched_at: optionalBackendString(data, "fetched_at", owner) }
      : {}),
  };
}

function parseBackendLocationWire(data: unknown, owner: string): BackendLocationWire {
  if (!isRecord(data)) {
    throw invalidBackendsResponse(`${owner} must be an object`);
  }
  const kind = requiredViewString(data, "kind", owner, invalidBackendsResponse);
  if (!backendLocationKinds.has(kind)) {
    throw invalidBackendsResponse(`${owner}.kind must be local or remote`);
  }
  return {
    kind: kind as BackendLocationKindWire,
    label: requiredViewString(data, "label", owner, invalidBackendsResponse),
  };
}

function parseBackendModelWire(data: unknown, owner: string): BackendModelWire {
  if (!isRecord(data)) {
    throw invalidBackendsResponse(`${owner} must be an object`);
  }
  return {
    ...(data as unknown as BackendModelWire),
    id: requiredBackendString(data, "id", owner),
    label: requiredBackendString(data, "label", owner),
    ...(data.description !== undefined
      ? { description: optionalBackendString(data, "description", owner) }
      : {}),
    ...(data.is_default !== undefined
      ? { is_default: optionalBackendBoolean(data, "is_default", owner) }
      : {}),
    reasoning_efforts: optionalBackendArray(data, "reasoning_efforts", owner).map(
      (option, index) => parseReasoningEffortOptionWire(option, `${owner}.reasoning_efforts[${index}]`),
    ),
    ...(data.metadata !== undefined
      ? { metadata: optionalBackendObject(data, "metadata", owner) }
      : {}),
  };
}

function parseReasoningEffortOptionWire(
  data: unknown,
  owner: string,
): ReasoningEffortOptionWire {
  if (!isRecord(data)) {
    throw invalidBackendsResponse(`${owner} must be an object`);
  }
  return {
    ...(data as unknown as ReasoningEffortOptionWire),
    id: requiredBackendString(data, "id", owner),
    label: requiredBackendString(data, "label", owner),
    ...(data.description !== undefined
      ? { description: optionalBackendString(data, "description", owner) }
      : {}),
    ...(data.is_default !== undefined
      ? { is_default: optionalBackendBoolean(data, "is_default", owner) }
      : {}),
    ...(data.metadata !== undefined
      ? { metadata: optionalBackendObject(data, "metadata", owner) }
      : {}),
  };
}

function parsePermissionModeOptionWire(data: unknown, owner: string): PermissionModeOptionWire {
  if (!isRecord(data)) {
    throw invalidBackendsResponse(`${owner} must be an object`);
  }
  const id = requiredBackendString(data, "id", owner);
  if (!permissionModes.has(id)) {
    throw invalidBackendsResponse(`${owner}.id must be a known PermissionMode`);
  }
  return {
    ...(data as unknown as PermissionModeOptionWire),
    id: id as PermissionModeWire,
    label: requiredBackendString(data, "label", owner),
    ...(data.description !== undefined
      ? { description: optionalBackendString(data, "description", owner) }
      : {}),
    ...(data.is_default !== undefined
      ? { is_default: optionalBackendBoolean(data, "is_default", owner) }
      : {}),
    ...(data.metadata !== undefined
      ? { metadata: optionalBackendObject(data, "metadata", owner) }
      : {}),
  };
}

function parseBackendFeatureWire(data: unknown, owner: string): BackendFeatureWire {
  if (!isRecord(data)) {
    throw invalidBackendsResponse(`${owner} must be an object`);
  }
  const type = requiredBackendString(data, "type", owner);
  const base: BackendFeatureBaseWire = {
    id: requiredBackendString(data, "id", owner),
    label: requiredBackendString(data, "label", owner),
    ...(data.description !== undefined
      ? { description: optionalBackendString(data, "description", owner) }
      : {}),
    ...(data.metadata !== undefined
      ? { metadata: optionalBackendObject(data, "metadata", owner) }
      : {}),
  };

  if (type === "toggle") {
    return {
      ...base,
      type: "toggle",
      default_value: requiredBackendBoolean(data, "default_value", owner),
    };
  }

  if (type === "select") {
    return {
      ...base,
      type: "select",
      ...(data.default_value !== undefined
        ? { default_value: optionalBackendStringOrNull(data, "default_value", owner) }
        : {}),
      options: requiredBackendArray(data, "options", owner).map((option, index) =>
        parseReasoningEffortOptionWire(option, `${owner}.options[${index}]`),
      ),
    };
  }

  throw invalidBackendsResponse(`${owner}.type must be toggle or select`);
}

export async function readBackendProbeResponse(response: Response): Promise<BackendProbeResultWire> {
  return parseBackendProbeResultWire(await readJsonResponse<unknown>(response));
}

export function parseBackendProbeResultWire(data: unknown): BackendProbeResultWire {
  if (!isRecord(data)) {
    throw invalidBackendProbeResponse("BackendProbeResult must be an object");
  }
  const backend = data.backend;
  if (typeof backend !== "string" || !backendKinds.has(backend)) {
    throw invalidBackendProbeResponse("BackendProbeResult.backend must be a known BackendKind");
  }
  const status = data.status;
  if (typeof status !== "string" || !backendStatuses.has(status)) {
    throw invalidBackendProbeResponse(
      "BackendProbeResult.status must be loading, available, unavailable, degraded, or error",
    );
  }
  const message = data.message;
  if (message !== undefined && typeof message !== "string") {
    throw invalidBackendProbeResponse("BackendProbeResult.message must be a string");
  }
  return {
    backend: backend as BackendKindWire,
    status: status as BackendProbeResultWire["status"],
    ...(message !== undefined ? { message } : {}),
  };
}

export async function readBackendSettingsResponse(
  response: Response,
): Promise<BackendSettingsWireResponse> {
  return parseBackendSettingsWireResponse(await readJsonResponse<unknown>(response));
}

export function parseBackendSettingsWireResponse(data: unknown): BackendSettingsWireResponse {
  if (!isRecord(data)) {
    throw invalidBackendSettingsResponse("BackendSettingsResponse must be an object");
  }
  const schema = data.schema;
  if (schema !== "velad.backend_settings.v1") {
    throw invalidBackendSettingsResponse(
      "BackendSettingsResponse.schema must be velad.backend_settings.v1",
    );
  }
  const backend = data.backend;
  if (typeof backend !== "string" || !backendKinds.has(backend)) {
    throw invalidBackendSettingsResponse(
      "BackendSettingsResponse.backend must be a known BackendKind",
    );
  }
  const settings = data.settings;
  if (!isRecord(settings)) {
    throw invalidBackendSettingsResponse("BackendSettingsResponse.settings must be an object");
  }
  const status = data.status;
  if (status !== "configured" && status !== "unconfigured") {
    throw invalidBackendSettingsResponse(
      "BackendSettingsResponse.status must be configured or unconfigured",
    );
  }
  const missingFields = data.missing_fields;
  if (!Array.isArray(missingFields) || missingFields.some((field) => typeof field !== "string")) {
    throw invalidBackendSettingsResponse(
      "BackendSettingsResponse.missing_fields must be a string array",
    );
  }
  const updatedAt = data.updated_at;
  if (updatedAt !== undefined && updatedAt !== null && typeof updatedAt !== "string") {
    throw invalidBackendSettingsResponse(
      "BackendSettingsResponse.updated_at must be a string or null",
    );
  }
  return {
    schema,
    backend: backend as BackendKindWire,
    settings: {
      ...settings,
      ...(typeof settings.endpoint === "string" ? { endpoint: settings.endpoint } : {}),
      ...(typeof settings.api_key_set === "boolean"
        ? { api_key_set: settings.api_key_set }
        : {}),
      ...(typeof settings.model === "string" ? { model: settings.model } : {}),
    },
    status,
    missing_fields: missingFields,
    ...(updatedAt !== undefined ? { updated_at: updatedAt } : {}),
  };
}

export function validateBackendSettingsPatch(patch: unknown): asserts patch is BackendSettingsPatchWire {
  if (!isRecord(patch)) {
    throw invalidBackendSettingsRequest("Backend settings patch must be an object");
  }
  validateOptionalBackendSettingsString(patch, "endpoint");
  validateOptionalBackendSettingsString(patch, "api_key");
  validateOptionalBackendSettingsString(patch, "model");
}

function validateOptionalBackendSettingsString(
  patch: Record<string, unknown>,
  field: string,
) {
  if (patch[field] !== undefined && typeof patch[field] !== "string") {
    throw invalidBackendSettingsRequest(`Backend settings ${field} must be a string`);
  }
}

export async function readConversationViewResponse(response: Response): Promise<ConversationWireView> {
  return parseConversationWireView(await readJsonResponse<unknown>(response));
}

export function parseConversationWireView(data: unknown): ConversationWireView {
  if (!isRecord(data)) {
    throw invalidConversationView("ConversationView must be an object");
  }
  const items = requiredViewArray(data, "items", "ConversationView", invalidConversationView);
  return {
    session_id: requiredViewString(data, "session_id", "ConversationView", invalidConversationView),
    items: items.map((item, index) =>
      parseConversationWireItem(item, `ConversationView.items[${index}]`),
    ),
    window: parseConversationWindow(data.window, invalidConversationView),
    cursor: requiredViewEventCursor(data, "cursor", "ConversationView", invalidConversationView),
  };
}

function parseConversationWireItem(data: unknown, owner: string): ConversationWireItem {
  if (!isRecord(data)) {
    throw invalidConversationView(`${owner} must be an object`);
  }
  const kind = requiredViewString(data, "kind", owner, invalidConversationView);
  if (!conversationItemKinds.has(kind)) {
    throw invalidConversationView(`${owner}.kind must be a known conversation item kind`);
  }
  const status = requiredViewString(data, "status", owner, invalidConversationView);
  if (!conversationItemStatuses.has(status)) {
    throw invalidConversationView(
      `${owner}.status must be pending, running, streaming, completed, failed, or cancelled`,
    );
  }
  const base = {
    ...(data as Record<string, unknown>),
    id: requiredViewString(data, "id", owner, invalidConversationView),
    kind: kind as ConversationItemKindWire,
    ...(data.turn_id !== undefined
      ? { turn_id: optionalViewString(data, "turn_id", owner, invalidConversationView) }
      : {}),
    created_at: requiredViewString(data, "created_at", owner, invalidConversationView),
    updated_at: requiredViewString(data, "updated_at", owner, invalidConversationView),
    revision: requiredViewInteger(data, "revision", owner, invalidConversationView, { minimum: 1 }),
    status: status as ConversationItemStatusWire,
    source_event_ids: requiredViewStringArray(
      data,
      "source_event_ids",
      owner,
      invalidConversationView,
    ),
    source_event_ranges: requiredSourceEventRanges(data, "source_event_ranges", owner),
  };

  if (kind === "user_message" || kind === "assistant_message") {
    return {
      ...base,
      kind,
      text: requiredViewString(data, "text", owner, invalidConversationView),
      ...(data.parts !== undefined
        ? { parts: parseMessageParts(data, `${owner}.parts`) }
        : {}),
    } as ConversationWireItem;
  }
  if (kind === "turn_meta") {
    return {
      ...base,
      kind,
      turn_id: requiredViewString(data, "turn_id", owner, invalidConversationView),
    } as ConversationWireItem;
  }
  if (kind === "agent_work") {
    return {
      ...base,
      kind,
      title: requiredViewString(data, "title", owner, invalidConversationView),
      ...(data.summary !== undefined
        ? { summary: optionalViewString(data, "summary", owner, invalidConversationView) }
        : {}),
      detail: parseAgentWorkDetailWire(data.detail, `${owner}.detail`),
      ...(data.event_range !== undefined
        ? { event_range: parseAgentWorkEventRange(data.event_range, `${owner}.event_range`) }
        : {}),
    } as ConversationWireItem;
  }
  return {
    ...base,
    kind: "status",
    text: requiredViewString(data, "text", owner, invalidConversationView),
  } as ConversationWireItem;
}

function parseMessageParts(
  data: Record<string, unknown>,
  owner: string,
): MessagePartWire[] {
  const parts = data.parts;
  if (!Array.isArray(parts)) {
    throw invalidConversationView(`${owner} must be an array`);
  }
  return parts.map((part, index) => parseMessagePart(part, `${owner}[${index}]`));
}

function parseMessagePart(data: unknown, owner: string): MessagePartWire {
  if (!isRecord(data)) {
    throw invalidConversationView(`${owner} must be an object`);
  }
  const type = requiredViewString(data, "type", owner, invalidConversationView);
  if (!messagePartTypes.has(type)) {
    throw invalidConversationView(`${owner}.type must be a known message part type`);
  }
  return {
    ...(data as unknown as MessagePartWire),
    id: requiredViewString(data, "id", owner, invalidConversationView),
    type: type as MessagePartTypeWire,
    ...(data.text !== undefined
      ? { text: optionalViewString(data, "text", owner, invalidConversationView) }
      : {}),
    ...(data.data !== undefined
      ? { data: optionalViewObject(data, "data", owner, invalidConversationView) }
      : {}),
  };
}

export async function readPendingRequestsViewResponse(response: Response): Promise<PendingRequestsWireView> {
  return parsePendingRequestsWireView(await readJsonResponse<unknown>(response));
}

export async function readDiffReviewViewResponse(response: Response): Promise<DiffReviewWireView> {
  return parseDiffReviewWireView(await readJsonResponse<unknown>(response));
}

export function parsePendingRequestsWireView(data: unknown): PendingRequestsWireView {
  if (!isRecord(data)) {
    throw invalidPendingRequestsView("PendingRequestsView must be an object");
  }
  const requests = requiredViewArray(
    data,
    "requests",
    "PendingRequestsView",
    invalidPendingRequestsView,
  );
  return {
    requests: requests.map((request, index) =>
      parseAgentRequestWire(request, `PendingRequestsView.requests[${index}]`),
    ),
    cursor: requiredCursorWindow(
      data,
      "cursor",
      "PendingRequestsView",
      invalidPendingRequestsView,
    ),
  };
}

export function parseDiffReviewWireView(data: unknown): DiffReviewWireView {
  if (!isRecord(data)) {
    throw invalidDiffReviewView("DiffReviewView must be an object");
  }
  const diffs = requiredViewArray(
    data,
    "diffs",
    "DiffReviewView",
    invalidDiffReviewView,
  );
  return {
    diffs: diffs.map((diff, index) =>
      parseDiffSummaryWire(diff, `DiffReviewView.diffs[${index}]`),
    ),
    cursor: requiredCursorWindow(data, "cursor", "DiffReviewView", invalidDiffReviewView),
  };
}

function parseDiffSummaryWire(data: unknown, owner: string): DiffSummaryWire {
  if (!isRecord(data)) {
    throw invalidDiffReviewView(`${owner} must be an object`);
  }
  const status = requiredViewString(data, "status", owner, invalidDiffReviewView);
  if (!diffSummaryStatuses.has(status)) {
    throw invalidDiffReviewView(`${owner}.status must be added, modified, deleted, or renamed`);
  }
  return {
    file_path: requiredViewString(data, "file_path", owner, invalidDiffReviewView),
    status: status as DiffSummaryStatusWire,
    ...(data.additions !== undefined
      ? { additions: optionalViewInteger(data, "additions", owner, invalidDiffReviewView) }
      : {}),
    ...(data.deletions !== undefined
      ? { deletions: optionalViewInteger(data, "deletions", owner, invalidDiffReviewView) }
      : {}),
  };
}

function parseAgentRequestWire(data: unknown, owner: string): AgentRequestWire {
  if (!isRecord(data)) {
    throw invalidPendingRequestsView(`${owner} must be an object`);
  }
  const type = requiredViewString(data, "type", owner, invalidPendingRequestsView);
  if (!requestTypes.has(type)) {
    throw invalidPendingRequestsView(`${owner}.type must be a known request type`);
  }
  const status = requiredViewString(data, "status", owner, invalidPendingRequestsView);
  if (!requestStatuses.has(status)) {
    throw invalidPendingRequestsView(`${owner}.status must be a known request status`);
  }
  return {
    id: requiredViewString(data, "id", owner, invalidPendingRequestsView),
    session_id: requiredViewString(data, "session_id", owner, invalidPendingRequestsView),
    type: type as AgentRequestTypeWire,
    status: status as RequestStatusWire,
    ...(data.title !== undefined
      ? { title: optionalViewString(data, "title", owner, invalidPendingRequestsView) }
      : {}),
    ...(data.description !== undefined
      ? {
          description: optionalViewString(
            data,
            "description",
            owner,
            invalidPendingRequestsView,
          ),
        }
      : {}),
    ...(data.payload !== undefined
      ? { payload: optionalViewObject(data, "payload", owner, invalidPendingRequestsView) }
      : {}),
    ...(data.backend_ref !== undefined
      ? {
          backend_ref: optionalViewObject(
            data,
            "backend_ref",
            owner,
            invalidPendingRequestsView,
          ),
        }
      : {}),
    created_at: requiredViewString(data, "created_at", owner, invalidPendingRequestsView),
    ...(data.resolved_at !== undefined
      ? { resolved_at: optionalViewString(data, "resolved_at", owner, invalidPendingRequestsView) }
      : {}),
  };
}

function parseAgentWorkDetailWire(data: unknown, owner: string): AgentWorkDetailWire {
  if (!isRecord(data)) {
    throw invalidAgentWorkDetail(`${owner} must be an object`);
  }
  const type = data.type;
  if (typeof type !== "string" || !agentWorkDetailTypes.has(type)) {
    throw invalidAgentWorkDetail(`${owner}.type must be a known activity detail type`);
  }
  if (type === "shell") {
    return {
      ...(data as Record<string, unknown>),
      type: "shell",
      ...(data.command !== undefined
        ? { command: optionalViewString(data, "command", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.cwd !== undefined
        ? { cwd: optionalViewString(data, "cwd", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.output !== undefined
        ? { output: optionalViewString(data, "output", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.stdout !== undefined
        ? { stdout: optionalViewString(data, "stdout", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.stderr !== undefined
        ? { stderr: optionalViewString(data, "stderr", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.exit_code !== undefined
        ? { exit_code: optionalViewInteger(data, "exit_code", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.error !== undefined
        ? { error: optionalViewString(data, "error", owner, invalidAgentWorkDetail) }
        : {}),
    };
  }
  if (type === "search") {
    return {
      ...(data as Record<string, unknown>),
      type: "search",
      ...(data.query !== undefined
        ? { query: optionalViewString(data, "query", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.mode !== undefined
        ? { mode: optionalViewEnum(data, "mode", owner, invalidAgentWorkDetail, agentWorkSearchModes) }
        : {}),
      ...(data.content !== undefined
        ? { content: optionalViewString(data, "content", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.num_matches !== undefined
        ? { num_matches: optionalViewInteger(data, "num_matches", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.num_files !== undefined
        ? { num_files: optionalViewInteger(data, "num_files", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.duration_ms !== undefined
        ? { duration_ms: optionalViewInteger(data, "duration_ms", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.truncated !== undefined
        ? { truncated: optionalViewBoolean(data, "truncated", owner, invalidAgentWorkDetail) }
        : {}),
    };
  }
  if (type === "read" || type === "edit" || type === "write") {
    return {
      ...(data as Record<string, unknown>),
      type: type as AgentWorkFileDetailTypeWire,
      ...(data.file_path !== undefined
        ? { file_path: optionalViewString(data, "file_path", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.path !== undefined
        ? { path: optionalViewString(data, "path", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.content !== undefined
        ? { content: optionalViewString(data, "content", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.old_string !== undefined
        ? { old_string: optionalViewString(data, "old_string", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.new_string !== undefined
        ? { new_string: optionalViewString(data, "new_string", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.unified_diff !== undefined
        ? { unified_diff: optionalViewString(data, "unified_diff", owner, invalidAgentWorkDetail) }
        : {}),
    };
  }
  if (type === "fetch") {
    return {
      ...(data as Record<string, unknown>),
      type: "fetch",
      ...(data.url !== undefined
        ? { url: optionalViewString(data, "url", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.prompt !== undefined
        ? { prompt: optionalViewString(data, "prompt", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.result !== undefined
        ? { result: optionalViewString(data, "result", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.code !== undefined
        ? { code: optionalViewInteger(data, "code", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.code_text !== undefined
        ? { code_text: optionalViewString(data, "code_text", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.bytes !== undefined
        ? { bytes: optionalViewInteger(data, "bytes", owner, invalidAgentWorkDetail) }
        : {}),
      ...(data.duration_ms !== undefined
        ? { duration_ms: optionalViewInteger(data, "duration_ms", owner, invalidAgentWorkDetail) }
        : {}),
    };
  }
  return { ...(data as Record<string, unknown>), type: type as AgentWorkGenericDetailTypeWire };
}

function parseAgentWorkEventRange(
  data: unknown,
  owner: string,
): { from_event_id?: string; to_event_id?: string } {
  if (!isRecord(data)) {
    throw invalidAgentWorkDetail(`${owner} must be an object`);
  }
  return {
    ...(data.from_event_id !== undefined
      ? { from_event_id: optionalViewString(data, "from_event_id", owner, invalidAgentWorkDetail) }
      : {}),
    ...(data.to_event_id !== undefined
      ? { to_event_id: optionalViewString(data, "to_event_id", owner, invalidAgentWorkDetail) }
      : {}),
  };
}

function requiredSourceEventRanges(
  data: Record<string, unknown>,
  field: string,
  owner: string,
) {
  const value = data[field];
  if (!Array.isArray(value)) {
    throw invalidConversationView(`${owner}.${field} must be an array`);
  }
  return value.map((range, index) =>
    parseSourceEventRange(range, `${owner}.${field}[${index}]`),
  );
}

function parseSourceEventRange(value: unknown, owner: string) {
  if (!isRecord(value)) {
    throw invalidConversationView(`${owner} must be an object`);
  }
  return {
    epoch: requiredViewInteger(value, "epoch", owner, invalidConversationView),
    from_event_id: requiredViewString(value, "from_event_id", owner, invalidConversationView),
    to_event_id: requiredViewString(value, "to_event_id", owner, invalidConversationView),
    from_seq: requiredViewInteger(value, "from_seq", owner, invalidConversationView),
    to_seq: requiredViewInteger(value, "to_seq", owner, invalidConversationView),
  };
}

export async function readCommandAckResponse(response: Response): Promise<CommandAckWire> {
  return parseCommandAckWire(await readJsonResponse<unknown>(response));
}

export function parseCommandAckWire(data: unknown): CommandAckWire {
  if (!isRecord(data)) {
    throw invalidCommandAck("CommandAck must be an object");
  }

  switch (data.status) {
    case "accepted":
      return {
        status: "accepted",
        command_id: requiredStringField(data, "command_id"),
        session_id: requiredStringField(data, "session_id"),
        ...(optionalStringField(data, "turn_id")
          ? { turn_id: optionalStringField(data, "turn_id") }
          : {}),
        cursor: requiredEventCursor(data, "cursor"),
      };
    case "queued":
      return {
        status: "queued",
        command_id: requiredStringField(data, "command_id"),
        session_id: requiredStringField(data, "session_id"),
        queued_message_id: requiredStringField(data, "queued_message_id"),
        cursor: requiredEventCursor(data, "cursor"),
      };
    case "rejected": {
      const cursor = optionalEventCursor(data, "cursor");
      return {
        status: "rejected",
        code: requiredStringField(data, "code") as CommandRejectionCodeWire,
        message: requiredStringField(data, "message"),
        ...(optionalStringField(data, "command_id")
          ? { command_id: optionalStringField(data, "command_id") }
          : {}),
        ...(optionalStringField(data, "session_id")
          ? { session_id: optionalStringField(data, "session_id") }
          : {}),
        ...(cursor ? { cursor } : {}),
      };
    }
    default:
      throw invalidCommandAck("CommandAck.status must be accepted, queued, or rejected");
  }
}

function requiredStringField(data: Record<string, unknown>, field: string) {
  const value = data[field];
  if (typeof value !== "string" || value.length === 0) {
    throw invalidCommandAck(`CommandAck.${String(data.status)} requires ${field}`);
  }
  return value;
}

function optionalStringField(data: Record<string, unknown>, field: string) {
  const value = data[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw invalidCommandAck(`CommandAck.${String(data.status)} ${field} must be a string`);
  }
  return value;
}

function requiredEventCursor(data: Record<string, unknown>, field: string) {
  const cursor = optionalEventCursor(data, field);
  if (!cursor) {
    throw invalidCommandAck(`CommandAck.${String(data.status)} requires ${field}`);
  }
  return cursor;
}

function optionalEventCursor(
  data: Record<string, unknown>,
  field: string,
): EventCursorWire | undefined {
  const value = data[field];
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw invalidCommandAck(`CommandAck.${String(data.status)} ${field} must be an object`);
  }
  const eventId = value.event_id;
  const epoch = value.epoch;
  const seq = value.seq;
  if (
    typeof eventId !== "string" ||
    eventId.length === 0 ||
    typeof epoch !== "number" ||
    !Number.isInteger(epoch) ||
    typeof seq !== "number" ||
    !Number.isInteger(seq)
  ) {
    throw invalidCommandAck(
      `CommandAck.${String(data.status)} ${field} must include event_id, epoch, and seq`,
    );
  }
  return { event_id: eventId, epoch, seq };
}

type ViewContractErrorFactory = (message: string) => VeladClientError;

function requiredSessionObject(
  data: Record<string, unknown>,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const session = data.session;
  if (!isRecord(session)) {
    throw invalid(`${owner} requires session`);
  }
  return parseSessionWire(session, `${owner}.session`, invalid);
}

function parseSessionSummaryWire(
  data: unknown,
  owner: string,
  invalid: ViewContractErrorFactory,
): SessionSummaryWire {
  if (!isRecord(data)) {
    throw invalid(`${owner} must be an object`);
  }
  const id = data.id;
  if (typeof id !== "string") {
    throw invalid(`${owner}.id must be a string`);
  }
  const backend = data.backend;
  if (typeof backend !== "string" || !backendKinds.has(backend)) {
    throw invalid(`${owner}.backend must be a known BackendKind`);
  }
  const status = data.status;
  if (typeof status !== "string" || !sessionStatuses.has(status)) {
    throw invalid(`${owner}.status must be a known SessionStatus`);
  }
  const title = requiredViewString(data, "title", owner, invalid);
  const updatedAt = requiredViewString(data, "updated_at", owner, invalid);
  const agentConfig = data.agent_config;
  if (agentConfig !== undefined) {
    validateAgentConfigShape(agentConfig, invalid, `${owner}.agent_config`);
  }
  return {
    ...(data as unknown as SessionSummaryWire),
    id,
    backend: backend as BackendKindWire,
    status: status as SessionStatusWire,
    title,
    updated_at: updatedAt,
    ...(agentConfig !== undefined ? { agent_config: agentConfig } : {}),
  };
}

function parseSessionListItemWire(
  data: unknown,
  owner: string,
  invalid: ViewContractErrorFactory,
): SessionListItemWire {
  if (!isRecord(data)) {
    throw invalid(`${owner} must be an object`);
  }
  const summary = parseSessionSummaryWire(data, owner, invalid);
  const workingDirectory = requiredViewString(data, "working_directory", owner, invalid);
  const createdAt = requiredViewString(data, "created_at", owner, invalid);
  const lastActivityAt = requiredViewString(data, "last_activity_at", owner, invalid);
  const preview = requiredViewString(data, "preview", owner, invalid);
  const pendingRequestCount = requiredViewInteger(data, "pending_request_count", owner, invalid);
  const activity = data.activity;
  const parsedActivity =
    activity !== undefined
      ? parseSessionActivityWire(activity, invalid, `${owner}.activity`)
      : undefined;
  const running = requiredViewBoolean(data, "running", owner, invalid);
  const model = data.model;
  if (model !== undefined && model !== null && typeof model !== "string") {
    throw invalid(`${owner}.model must be a string or null`);
  }
  return {
    ...(data as unknown as SessionListItemWire),
    ...summary,
    working_directory: workingDirectory,
    created_at: createdAt,
    last_activity_at: lastActivityAt,
    preview,
    pending_request_count: pendingRequestCount,
    ...(parsedActivity !== undefined ? { activity: parsedActivity } : {}),
    running,
    ...(model !== undefined ? { model: model as string | null } : {}),
  };
}

function parseSessionActivityWire(
  data: unknown,
  invalid: ViewContractErrorFactory,
  owner: string,
): SessionActivityWire {
  if (!isRecord(data)) {
    throw invalid(`${owner} must be an object`);
  }
  const phase = data.phase;
  if (typeof phase !== "string" || !sessionActivityPhases.has(phase)) {
    throw invalid(`${owner}.phase must be a known SessionActivityPhase`);
  }
  const attention = data.attention;
  if (typeof attention !== "string" || !sessionActivityAttentions.has(attention)) {
    throw invalid(`${owner}.attention must be a known SessionActivityAttention`);
  }
  const pendingRequestCount = requiredViewInteger(data, "pending_request_count", owner, invalid);
  return {
    ...(data as unknown as SessionActivityWire),
    phase: phase as SessionActivityPhaseWire,
    attention: attention as SessionActivityAttentionWire,
    pending_request_count: pendingRequestCount,
  };
}

function parseSessionWire(
  data: Record<string, unknown>,
  owner: string,
  invalid: ViewContractErrorFactory,
): SessionWire {
  const id = data.id;
  if (typeof id !== "string") {
    throw invalid(`${owner}.id must be a string`);
  }
  const backend = data.backend;
  if (typeof backend !== "string" || !backendKinds.has(backend)) {
    throw invalid(`${owner}.backend must be a known BackendKind`);
  }
  const status = data.status;
  if (typeof status !== "string" || !sessionStatuses.has(status)) {
    throw invalid(`${owner}.status must be a known SessionStatus`);
  }
  const title = requiredViewString(data, "title", owner, invalid);
  const workingDirectory = requiredViewString(data, "working_directory", owner, invalid);
  const createdAt = requiredViewString(data, "created_at", owner, invalid);
  const updatedAt = requiredViewString(data, "updated_at", owner, invalid);
  const agentConfig = data.agent_config;
  if (agentConfig !== undefined) {
    validateAgentConfigShape(agentConfig, invalid, `${owner}.agent_config`);
  }
  const runtimeInfo = data.runtime_info;
  const parsedRuntimeInfo =
    runtimeInfo !== undefined
      ? parseSessionRuntimeInfoWire(runtimeInfo, invalid, `${owner}.runtime_info`)
      : undefined;
  const operations = data.operations;
  if (operations !== undefined) {
    validateSessionOperationsShape(operations, invalid, `${owner}.operations`);
  }
  const activity = data.activity;
  const parsedActivity =
    activity !== undefined
      ? parseSessionActivityWire(activity, invalid, `${owner}.activity`)
      : undefined;
  return {
    ...(data as unknown as SessionWire),
    id,
    backend: backend as BackendKindWire,
    status: status as SessionStatusWire,
    title,
    working_directory: workingDirectory,
    created_at: createdAt,
    updated_at: updatedAt,
    ...(agentConfig !== undefined ? { agent_config: agentConfig } : {}),
    ...(parsedRuntimeInfo !== undefined ? { runtime_info: parsedRuntimeInfo } : {}),
    ...(parsedActivity !== undefined ? { activity: parsedActivity } : {}),
    ...(operations !== undefined ? { operations } : {}),
  };
}

function requiredEffectiveAfter(data: Record<string, unknown>) {
  const value = data.effective_after;
  if (value !== "current_session" && value !== "next_turn") {
    throw invalidUpdateAgentConfigResponse(
      "UpdateAgentConfigResponse.effective_after must be current_session or next_turn",
    );
  }
  return value;
}

function requiredViewString(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (typeof value !== "string") {
    throw invalid(`${owner} requires ${field}`);
  }
  return value;
}

function requiredViewArray(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (!Array.isArray(value)) {
    throw invalid(`${owner} requires ${field}`);
  }
  return value;
}

function optionalViewString(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw invalid(`${owner}.${field} must be a string`);
  }
  return value;
}

function optionalViewEnum<T extends string>(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
  values: ReadonlySet<T>,
) {
  const value = data[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(values as ReadonlySet<string>).has(value)) {
    throw invalid(`${owner}.${field} must be a known value`);
  }
  return value as T;
}

function optionalViewInteger(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalid(`${owner}.${field} must be an integer`);
  }
  return value;
}

function optionalViewBoolean(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw invalid(`${owner}.${field} must be a boolean`);
  }
  return value;
}

function optionalViewObject(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw invalid(`${owner}.${field} must be an object`);
  }
  return value;
}

function requiredCursorWindow(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
): CursorWindow {
  const value = data[field];
  if (!isRecord(value)) {
    throw invalid(`${owner} requires ${field}`);
  }
  const cursorOwner = `${owner}.${field}`;
  return {
    ...(value.event_id !== undefined
      ? { event_id: optionalViewString(value, "event_id", cursorOwner, invalid) }
      : {}),
    ...(value.epoch !== undefined
      ? { epoch: optionalViewInteger(value, "epoch", cursorOwner, invalid) }
      : {}),
    ...(value.seq !== undefined
      ? { seq: optionalViewInteger(value, "seq", cursorOwner, invalid) }
      : {}),
    ...(value.from_seq !== undefined
      ? { from_seq: optionalViewInteger(value, "from_seq", cursorOwner, invalid) }
      : {}),
    ...(value.to_seq !== undefined
      ? { to_seq: optionalViewInteger(value, "to_seq", cursorOwner, invalid) }
      : {}),
    ...(value.latest_event_id !== undefined
      ? {
          latest_event_id: optionalViewString(value, "latest_event_id", cursorOwner, invalid),
        }
      : {}),
    ...(value.next_event_id !== undefined
      ? { next_event_id: optionalViewString(value, "next_event_id", cursorOwner, invalid) }
      : {}),
    ...(value.has_more !== undefined
      ? { has_more: optionalViewBoolean(value, "has_more", cursorOwner, invalid) }
      : {}),
    ...(value.has_newer !== undefined
      ? { has_newer: optionalViewBoolean(value, "has_newer", cursorOwner, invalid) }
      : {}),
    ...(value.has_older !== undefined
      ? { has_older: optionalViewBoolean(value, "has_older", cursorOwner, invalid) }
      : {}),
  };
}

function requiredViewInteger(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
  options?: { minimum?: number },
) {
  const value = data[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalid(`${owner} requires ${field}`);
  }
  if (options?.minimum !== undefined && value < options.minimum) {
    throw invalid(`${owner}.${field} must be at least ${options.minimum}`);
  }
  return value;
}

function requiredViewBoolean(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (typeof value !== "boolean") {
    throw invalid(`${owner} requires boolean ${field}`);
  }
  return value;
}

function requiredViewStringArray(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalid(`${owner} requires ${field}`);
  }
  return value as string[];
}

function requiredBackendCapabilities(
  data: Record<string, unknown>,
  owner: string,
): BackendCapabilitiesWire {
  const value = data.capabilities;
  if (!isRecord(value)) {
    throw invalidBackendsResponse(`${owner} requires capabilities`);
  }
  for (const field of backendCapabilityFields) {
    if (typeof value[field] !== "boolean") {
      throw invalidBackendsResponse(`${owner}.capabilities requires ${field}`);
    }
  }
  return value as BackendCapabilitiesWire;
}

function optionalBackendArray(data: Record<string, unknown>, field: string, owner: string) {
  const value = data[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw invalidBackendsResponse(`${owner}.${field} must be an array`);
  }
  return value;
}

function requiredBackendArray(data: Record<string, unknown>, field: string, owner: string) {
  const value = data[field];
  if (!Array.isArray(value)) {
    throw invalidBackendsResponse(`${owner}.${field} must be an array`);
  }
  return value;
}

function requiredBackendString(data: Record<string, unknown>, field: string, owner: string) {
  const value = data[field];
  if (typeof value !== "string") {
    throw invalidBackendsResponse(`${owner}.${field} must be a string`);
  }
  return value;
}

function requiredBackendKind(
  data: Record<string, unknown>,
  field: string,
  owner: string,
): BackendKindWire {
  const value = requiredBackendString(data, field, owner);
  if (!backendKinds.has(value)) {
    throw invalidBackendsResponse(`${owner}.${field} must be a known BackendKind`);
  }
  return value as BackendKindWire;
}

function requiredBackendUsageStatus(
  data: Record<string, unknown>,
  field: string,
  owner: string,
): BackendUsageStatusWire {
  const value = requiredBackendString(data, field, owner);
  if (!backendUsageStatuses.has(value)) {
    throw invalidBackendsResponse(`${owner}.${field} must be ok, needs_auth, unsupported, or error`);
  }
  return value as BackendUsageStatusWire;
}

function optionalBackendString(data: Record<string, unknown>, field: string, owner: string) {
  const value = data[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw invalidBackendsResponse(`${owner}.${field} must be a string`);
  }
  return value;
}

function optionalBackendStringOrNull(
  data: Record<string, unknown>,
  field: string,
  owner: string,
) {
  const value = data[field];
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string") return value;
  throw invalidBackendsResponse(`${owner}.${field} must be a string or null`);
}

function requiredBackendBoolean(data: Record<string, unknown>, field: string, owner: string) {
  const value = data[field];
  if (typeof value !== "boolean") {
    throw invalidBackendsResponse(`${owner}.${field} must be a boolean`);
  }
  return value;
}

function optionalBackendBoolean(data: Record<string, unknown>, field: string, owner: string) {
  const value = data[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw invalidBackendsResponse(`${owner}.${field} must be a boolean`);
  }
  return value;
}

function optionalBackendNumber(data: Record<string, unknown>, field: string, owner: string) {
  const value = data[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidBackendsResponse(`${owner}.${field} must be a finite number`);
  }
  return value;
}

function optionalBackendObject(data: Record<string, unknown>, field: string, owner: string) {
  const value = data[field];
  if (!isRecord(value)) {
    throw invalidBackendsResponse(`${owner}.${field} must be an object`);
  }
  return value;
}

function requiredViewEventCursor(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  return parseViewEventCursor(data[field], `${owner}.${field}`, invalid);
}

function parseViewEventCursor(
  value: unknown,
  owner: string,
  invalid: ViewContractErrorFactory,
): EventCursorWire {
  if (!isRecord(value)) {
    throw invalid(`${owner} must be an object`);
  }
  const eventId = value.event_id;
  const epoch = value.epoch;
  const seq = value.seq;
  if (
    typeof eventId !== "string" ||
    eventId.length === 0 ||
    typeof epoch !== "number" ||
    !Number.isInteger(epoch) ||
    typeof seq !== "number" ||
    !Number.isInteger(seq)
  ) {
    throw invalid(`${owner} must include event_id, epoch, and seq`);
  }
  return { event_id: eventId, epoch, seq };
}

function parseConversationWindow(value: unknown, invalid: ViewContractErrorFactory): ConversationWindow {
  const window = parseViewWindow(value, "ConversationView.window", invalid);
  return {
    ...optionalNullableWindowString(window, "first_item_id", "ConversationView.window", invalid),
    ...optionalNullableWindowString(window, "last_item_id", "ConversationView.window", invalid),
    ...optionalNullableWindowString(window, "anchor_item_id", "ConversationView.window", invalid),
    has_older: window.has_older,
    has_newer: window.has_newer,
  };
}

function parseViewWindow(value: unknown, owner: string, invalid: ViewContractErrorFactory) {
  if (!isRecord(value)) {
    throw invalid(`${owner} must be an object`);
  }
  const hasOlder = value.has_older;
  const hasNewer = value.has_newer;
  if (typeof hasOlder !== "boolean" || typeof hasNewer !== "boolean") {
    throw invalid(`${owner} requires has_older and has_newer`);
  }
  return { ...value, has_older: hasOlder, has_newer: hasNewer };
}

function optionalNullableWindowString(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (value === undefined) return {};
  if (value === null || typeof value === "string") return { [field]: value };
  throw invalid(`${owner}.${field} must be a string or null`);
}

function optionalNullableViewString(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (value === undefined || value === null || typeof value === "string") return value;
  throw invalid(`${owner}.${field} must be a string or null`);
}

function invalidCommandAck(message: string) {
  return new VeladClientError("invalid_command_ack", message);
}

function invalidInputPart(message: string) {
  return new VeladClientError("invalid_input_part", message);
}

function invalidInputEvent(message: string) {
  return new VeladClientError("invalid_input_event", message);
}

function invalidIdempotencyKey(message: string) {
  return new VeladClientError("invalid_idempotency_key", message);
}

function invalidSessionId(message: string) {
  return new VeladClientError("invalid_session_id", message);
}

function invalidAfterId(message: string) {
  return new VeladClientError("invalid_after_id", message);
}

function invalidBackendKind(message: string) {
  return new VeladClientError("invalid_backend_kind", message);
}

function invalidCreateSessionRequest(message: string) {
  return new VeladClientError("invalid_create_session_request", message);
}

function invalidAgentConfigPatch(message: string) {
  return new VeladClientError("invalid_agent_config_patch", message);
}

function invalidCreateSessionResponse(message: string) {
  return new VeladClientError("invalid_create_session_response", message);
}

function invalidUpdateAgentConfigResponse(message: string) {
  return new VeladClientError("invalid_update_agent_config_response", message);
}

function invalidSessionResponse(message: string) {
  return new VeladClientError("invalid_session_response", message);
}

function invalidBackendsResponse(message: string) {
  return new VeladClientError("invalid_backends_response", message);
}

function invalidBackendProbeResponse(message: string) {
  return new VeladClientError("invalid_backend_probe_response", message);
}

function invalidBackendSettingsRequest(message: string) {
  return new VeladClientError("invalid_backend_settings_request", message);
}

function invalidBackendSettingsResponse(message: string) {
  return new VeladClientError("invalid_backend_settings_response", message);
}

function invalidConversationView(message: string) {
  return new VeladClientError("invalid_conversation_view", message);
}

function invalidAgentWorkDetail(message: string) {
  return new VeladClientError("invalid_agent_work_detail", message);
}

function invalidPendingRequestsView(message: string) {
  return new VeladClientError("invalid_pending_requests_view", message);
}

function invalidDiffReviewView(message: string) {
  return new VeladClientError("invalid_diff_review_view", message);
}
