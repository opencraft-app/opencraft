import type {
  AppServerClientInfo,
  AppServerParams,
  JsonRpcId,
  JsonRpcResponse,
} from "../types/appserver.ts";
import { base64Decode, base64Encode, utf8Decode, utf8Encode } from "../runtime/bytes.ts";
import type {
  ExecutionCredential,
  ExecutionProfile,
  RuntimeExecutionHint,
} from "./execution-profile.ts";
import {
  createExecutionProfile,
  executionProfileFromRuntimeHint,
  executionProfilesCompatible,
} from "./execution-profile.ts";
import { effectiveRequestedModel } from "./model-route.ts";
import {
  projectedHistoryHeadCursors,
  projectedTurnsPage,
  type ProjectedThread,
  type ProjectedTurn,
  type ProjectionPageParams,
} from "./transparent-thread-history.ts";

export type ProtocolRecord = Record<string, unknown>;

interface CollaborationSettings extends ProtocolRecord {
  model?: string | null;
  reasoningEffort?: unknown;
  developerInstructions?: unknown;
}

interface CollaborationMode extends ProtocolRecord {
  mode?: string;
  settings?: CollaborationSettings | null;
}

export interface ThreadSettingsShape extends ProtocolRecord {
  cwd?: string | null | undefined;
  model?: string | null;
  effort?: unknown;
  reasoningEffort?: unknown;
  collaborationMode?: CollaborationMode | null;
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  sandboxPolicy?: SandboxPolicy | null;
  sandbox?: SandboxPolicy | string | null;
  activePermissionProfile?: unknown;
  serviceTier?: unknown;
  summary?: unknown;
  multiAgentMode?: unknown;
  personality?: unknown;
  permissions?: unknown;
  runtimeWorkspaceRoots?: unknown;
  initialTurnsPage?: Partial<ProjectionPageParams> | null;
  excludeTurns?: boolean;
  threadId?: string | undefined;
  path?: string | undefined;
  ephemeral?: unknown;
  threadSource?: unknown;
  authMode?: unknown;
  account?: unknown;
}

export interface SandboxPolicy extends ProtocolRecord {
  type: string;
  writableRoots?: string[];
  networkAccess?: boolean;
  excludeSlashTmp?: boolean;
  excludeTmpdirEnvVar?: boolean;
}

interface TransparentThread extends ProjectedThread {
  cwd: string;
}

interface SocketSender {
  send(message: JsonRpcResponse): void;
}

interface RoutingConnection {
  socket: SocketSender;
  clientInfo?: AppServerClientInfo | null;
  initializeParams?: AppServerParams | null;
  identity?: { id?: string; [key: string]: unknown } | null;
}

interface ResumeModelProjectionContext {
  modelGateway: {
    activeForConnection(connection: RoutingConnection): {
      model?: string | null;
      providerId?: string | null;
    } | null;
  };
}

interface ResumeProjectionContext extends ResumeModelProjectionContext {
  threadManager: {
    reconcileInterruptedRuntime(threadId: string): ProjectedTurn[];
  };
  threadExecution?: {
    complete?(threadId: string, result: ProtocolRecord): unknown;
  };
  appServer: {
    broadcastNotification(method: string, params: ProtocolRecord): void;
  };
}

export interface DeviceCredential extends ExecutionCredential {
  installationId?: string | null;
  bindingState?: string | null;
  providerId?: string | null;
  username?: string | null;
}

interface ProviderRoute {
  id?: string | null;
  providerId?: string | null;
  model?: string | null;
  displayName?: string | null;
}

interface ExecutionRoute {
  engineKind?: string | null;
  kind?: string | null;
  provider?: ProviderRoute | null;
}

interface RuntimeState {
  executionProfile?: Partial<ExecutionProfile> | null;
}

interface TurnStartMessage extends ProtocolRecord {
  method?: string;
  params?: ThreadSettingsShape;
}

export const USER_BACKEND_CONTROL_METHODS: ReadonlySet<string> = new Set([
  "account/read",
  "account/login/start",
  "account/login/cancel",
  "account/logout",
  "command/exec",
  "command/exec/write",
  "command/exec/terminate",
  "command/exec/resize",
  "process/spawn",
  "process/writeStdin",
  "process/resizePty",
  "process/kill",
  "collaborationMode/list",
  "model/list",
]);

export const USER_BACKEND_GLOBAL_CONTROL_METHODS: ReadonlySet<string> = new Set([
  "account/read",
  "account/login/start",
  "account/login/cancel",
  "account/logout",
  "collaborationMode/list",
  "model/list",
]);

export const COMMAND_EXEC_METHODS: ReadonlySet<string> = new Set([
  "command/exec",
  "command/exec/write",
  "command/exec/terminate",
  "command/exec/resize",
]);

export const HOST_PROCESS_METHODS: ReadonlySet<string> = new Set([
  "process/spawn",
  "process/writeStdin",
  "process/resizePty",
  "process/kill",
]);

export const CODEX_ACCOUNT_NOT_BOUND = -32051;

export function deepMap(
  value: unknown,
  mapString: (value: string) => string,
): unknown {
  if (typeof value === "string") return mapString(value);
  if (Array.isArray(value)) return value.map((item) => deepMap(item, mapString));
  if (!isRecord(value)) return value;
  const result: ProtocolRecord = {};
  for (const [key, item] of Object.entries(value)) result[key] = deepMap(item, mapString);
  return result;
}

export function hasOwn(object: unknown, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

export function defaultSandboxPolicy(cwd: string): SandboxPolicy {
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeSlashTmp: false,
    excludeTmpdirEnvVar: false,
  };
}

export function sandboxPolicyForPermission(permission: unknown, cwd: string): SandboxPolicy {
  const profile = String(permission ?? "").replace(/^:/, "");
  if (profile === "danger-full-access") return { type: "dangerFullAccess" };
  if (profile === "read-only") return { type: "readOnly", networkAccess: false };
  return defaultSandboxPolicy(cwd);
}

export function projectedThreadSettings(
  params: ThreadSettingsShape = {},
  previous: ThreadSettingsShape = {},
  opened: ThreadSettingsShape = {},
  thread: ThreadSettingsShape = {},
  providerId = "openai",
): ThreadSettingsShape {
  const cwd = params.cwd ?? previous.cwd ?? opened.cwd ?? thread.cwd ?? "/workspace";
  const model = params.model ?? previous.model ?? opened.model ?? "gpt-5.6-sol";
  const effort = hasOwn(params, "effort")
    ? params.effort
    : (previous.effort ?? opened.reasoningEffort ?? null);
  const baseMode = params.collaborationMode ?? previous.collaborationMode ?? {
    mode: "default",
    settings: { model, reasoningEffort: effort, developerInstructions: null },
  };
  const collaborationMode: CollaborationMode = {
    ...baseMode,
    settings: {
      ...(baseMode.settings ?? {}),
      model,
      reasoningEffort: effort,
    },
  };
  return {
    cwd,
    approvalPolicy: params.approvalPolicy ?? previous.approvalPolicy ?? opened.approvalPolicy ?? "on-request",
    approvalsReviewer: params.approvalsReviewer ?? previous.approvalsReviewer ?? opened.approvalsReviewer ?? "user",
    sandboxPolicy: params.sandboxPolicy ?? previous.sandboxPolicy ??
      (typeof opened.sandbox === "object" ? opened.sandbox : null) ?? defaultSandboxPolicy(cwd),
    activePermissionProfile: previous.activePermissionProfile ?? opened.activePermissionProfile ?? null,
    model,
    modelProvider: providerId,
    serviceTier: hasOwn(params, "serviceTier")
      ? params.serviceTier
      : (previous.serviceTier ?? opened.serviceTier ?? null),
    effort,
    summary: hasOwn(params, "summary") ? params.summary : (previous.summary ?? null),
    collaborationMode,
    multiAgentMode: params.multiAgentMode ?? previous.multiAgentMode ?? opened.multiAgentMode ?? "explicitRequestOnly",
    personality: hasOwn(params, "personality") ? params.personality : (previous.personality ?? null),
  };
}

export function completeOrphanInterrupt(
  ctx: ResumeProjectionContext,
  connection: RoutingConnection,
  threadId: string,
  requestId: JsonRpcId | undefined,
): true {
  const interrupted = ctx.threadManager.reconcileInterruptedRuntime(threadId);
  ctx.threadExecution?.complete?.(threadId, { reason: "interruptConverged" });
  connection.socket.send({ ...(requestId === undefined ? {} : { id: requestId }), result: {} });
  for (const turn of interrupted) {
    ctx.appServer.broadcastNotification("turn/completed", {
      threadId,
      turn: { ...turn, itemsView: "summary" },
    });
  }
  ctx.appServer.broadcastNotification("thread/status/changed", {
    threadId,
    status: { type: "idle" },
  });
  return true;
}

export function projectedResumeResult(
  ctx: ResumeModelProjectionContext,
  connection: RoutingConnection,
  thread: TransparentThread,
  params: ThreadSettingsShape = {},
): ProtocolRecord {
  const active = ctx.modelGateway.activeForConnection(connection);
  return projectedResumeResultForModel(active, thread, params);
}

export function projectedResumeResultForModel(
  active: { model?: string | null; providerId?: string | null } | null,
  thread: TransparentThread,
  params: ThreadSettingsShape = {},
): ProtocolRecord {
  const model = active?.model ?? "gpt-5.6-sol";
  const modelProvider = active?.providerId ?? "openai";
  const cursors = projectedHistoryHeadCursors(thread);
  const responseThread = params.excludeTurns === true ? { ...thread, turns: [] } : thread;
  const initialTurnsPage = params.initialTurnsPage == null
    ? undefined
    : projectedTurnsPage(thread, { threadId: thread.id, ...params.initialTurnsPage });
  return {
    thread: responseThread,
    model,
    modelProvider,
    serviceTier: params.serviceTier ?? null,
    reasoningEffort: params.effort ?? null,
    cwd: thread.cwd,
    approvalPolicy: params.approvalPolicy ?? "on-request",
    approvalsReviewer: params.approvalsReviewer ?? "user",
    sandbox: params.permissions
      ? sandboxPolicyForPermission(params.permissions, thread.cwd)
      : (params.sandboxPolicy ?? defaultSandboxPolicy(thread.cwd)),
    runtimeWorkspaceRoots: params.runtimeWorkspaceRoots ?? [],
    instructionSources: [],
    ...(initialTurnsPage === undefined ? {} : { initialTurnsPage }),
    ...cursors,
  };
}

export function transparentThreadOpenParams(
  method: string,
  requested: ThreadSettingsShape = {},
  routing: ThreadSettingsShape = {},
): ThreadSettingsShape {
  const params = { ...requested };
  // Projects are catalog entities owned by HyperNode's stable outer Thread.
  // A private Codex app-server process has an independent, empty project
  // catalog, so forwarding the outer id makes native thread/start or
  // thread/resume fail with `project not found`.  Keep the binding on the
  // outer Thread and never expose it across the engine boundary.
  delete params["projectId"];
  if (method === "thread/start") {
    delete params.threadId;
    delete params.path;
    if (params.ephemeral === undefined && routing.ephemeral !== undefined) {
      params.ephemeral = routing.ephemeral;
    }
    if (params.threadSource === undefined && routing.threadSource !== undefined) {
      params.threadSource = routing.threadSource;
    }
  } else if (method === "thread/resume") {
    if (routing.path !== undefined) {
      // A committed artifact is the exact rollout generation HyperNode chose
      // for this outer Thread. Codex gives a non-empty path precedence for a
      // non-running thread, but its wire schema still requires threadId. Both
      // values must therefore come from the same artifact generation.
      params.path = routing.path;
      params.threadId = routing.threadId;
    } else if (routing.threadId !== undefined) {
      // Before the first artifact exists, the native inner id is the only
      // durable locator. Never pair it with a client-supplied stale path.
      params.threadId = routing.threadId;
      delete params.path;
    }
  } else {
    throw new Error(`unsupported transparent thread open method: ${method}`);
  }
  params.cwd = routing.cwd;
  return params;
}

export function decodeUtf8Base64(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return utf8Decode(base64Decode(value));
  } catch {
    return null;
  }
}

export function encodeUtf8Base64(value: string): string {
  return base64Encode(utf8Encode(value));
}

const TURN_TO_THREAD_RESUME_SETTING_KEYS = [
  "approvalPolicy", "approvalsReviewer", "baseInstructions", "config", "developerInstructions",
  "model", "modelProvider", "permissions", "personality", "runtimeWorkspaceRoots", "serviceTier",
] as const;

export function threadResumeSettingsFromTurn(params: ThreadSettingsShape = {}): ThreadSettingsShape {
  const settings = pick(params, TURN_TO_THREAD_RESUME_SETTING_KEYS);
  if (settings["permissions"] === undefined && params.sandboxPolicy?.type) {
    const type = params.sandboxPolicy.type;
    settings["sandbox"] = type === "dangerFullAccess"
      ? "danger-full-access"
      : (type === "readOnly" ? "read-only" : "workspace-write");
  }
  return settings;
}

export function normalizeTurnModel(
  message: TurnStartMessage,
  runtimeHint: RuntimeExecutionHint | null = null,
  routeModel: string | null = null,
): TurnStartMessage {
  if (message.method !== "turn/start") return message;
  const model = routeModel ?? effectiveRequestedModel(message.params ?? {}, runtimeHint);
  if (!model || message.params?.model === model) return message;
  return { ...message, params: { ...(message.params ?? {}), model } };
}

export function resumeRouteOverride(
  params: ThreadSettingsShape = {},
  runtimeHint: RuntimeExecutionHint | null = null,
  providerId: string | null = null,
): ThreadSettingsShape {
  const model = effectiveRequestedModel(params, runtimeHint == null ? null : { model: runtimeHint.model });
  return { ...(model ? { model } : {}), modelProvider: providerId ?? "openai" };
}

export function codexAccountNotBoundError(device: DeviceCredential): ProtocolRecord {
  return {
    code: CODEX_ACCOUNT_NOT_BOUND,
    message: `Codex account is not bound for SSH user ${device.username ?? device.userId ?? "unknown"}. Complete ChatGPT device login before starting a /localhost turn.`,
    data: {
      kind: "codexAccountNotBound",
      userId: device.userId,
      username: device.username,
      installationId: device.installationId,
      bindingState: device.bindingState,
      loginMethod: "chatgptDeviceCode",
    },
  };
}

export function modelProviderCredentialMissingError(
  device: DeviceCredential,
  provider: ProviderRoute,
): ProtocolRecord {
  return {
    code: CODEX_ACCOUNT_NOT_BOUND,
    message: `API key for model provider ${provider.displayName} is not loaded for SSH user ${device.username}. Open the HyperNode HTTP dashboard on port 9988 and provide it again.`,
    data: {
      kind: "modelProviderCredentialMissing",
      userId: device.userId,
      username: device.username,
      providerId: provider.providerId,
    },
  };
}

export function codexAccountHandoffRequiredError(
  actor: DeviceCredential,
  owner: DeviceCredential,
): ProtocolRecord {
  return {
    code: -32069,
    message: `Transparent thread is currently executing with ${owner.username}'s runtime; an execution-engine switch is required before ${actor.username} can start the next turn.`,
    data: {
      kind: "codexAccountHandoffRequired",
      transitionKind: "executionEngineSwitchRequired",
      actorUsername: actor.username,
      backendUsername: owner.username,
    },
  };
}

export function accountUpdatedBindingState(params: unknown): "bound" | "unbound" {
  const account = isRecord(params) ? params : {};
  const hasAuthMode = hasOwn(account, "authMode");
  const bound = hasAuthMode ? account["authMode"] != null : account["account"] != null;
  return bound ? "bound" : "unbound";
}

export function runtimeNeedsAccountHandoff(
  runtimeHint: RuntimeExecutionHint | null | undefined,
  fallbackCredential: DeviceCredential | null | undefined,
  actorCredential: DeviceCredential | null | undefined,
): boolean {
  const residentAccountIdentity = runtimeHint?.accountIdentity ?? fallbackCredential?.accountIdentity;
  return !residentAccountIdentity || residentAccountIdentity !== actorCredential?.accountIdentity;
}

export function executionProfileForRoute(
  route: ExecutionRoute | null | undefined,
  actorCredential: DeviceCredential | null | undefined,
  model: string | null | undefined,
  turnParams: ThreadSettingsShape = {},
): ExecutionProfile {
  const engineKind = route?.engineKind ?? ((route?.provider || actorCredential?.providerId) ? "dsh" : "codex");
  const actorUserId = actorCredential?.userId ?? null;
  return createExecutionProfile({
    engineKind,
    providerId: route?.provider?.providerId ?? route?.provider?.id ?? actorCredential?.providerId ?? "openai",
    model: route?.provider?.model ?? model ?? null,
    credential: actorCredential ?? null,
    actorUserId,
    turnConfig: pick(turnParams, [
      "approvalPolicy", "approvalsReviewer", "collaborationMode", "effort", "permissions",
      "runtimeWorkspaceRoots", "sandbox", "sandboxPolicy", "serviceTier", "summary",
    ]),
  });
}

export function runtimeNeedsExecutionHandoff(
  state: RuntimeState | null | undefined,
  runtimeHint: RuntimeExecutionHint | null | undefined,
  executionProfile: ExecutionProfile,
): boolean {
  const residentProfile = state?.executionProfile ?? executionProfileFromRuntimeHint(runtimeHint ?? null);
  if (!residentProfile) return true;
  if (executionProfilesCompatible(residentProfile, executionProfile)) return false;
  // Older/provisional Codex bindings can legitimately have no model recorded:
  // thread/start selected the native account first and Codex filled its default
  // model later. The first explicit Desktop model merely completes that hint;
  // it is not an account/provider transition and must not snapshot the rollout.
  if (residentProfile.engineKind === "codex" && executionProfile.engineKind === "codex" &&
      residentProfile.model == null) {
    const completedResident = createExecutionProfile({
      engineKind: residentProfile.engineKind,
      providerId: residentProfile.providerId,
      model: executionProfile.model,
      credential: {
        accountIdentity: residentProfile.credentialIdentity,
        userId: residentProfile.actorUserId,
      },
      actorUserId: residentProfile.actorUserId,
    });
    return !executionProfilesCompatible(completedResident, executionProfile);
  }
  return true;
}

export function providerIdFromAccountIdentity(
  accountIdentity: unknown,
  ownerUserId: string | null = null,
): string | null {
  if (typeof accountIdentity !== "string") return null;
  const publicPrefix = "model-provider:public:";
  if (accountIdentity.startsWith(publicPrefix)) return accountIdentity.slice(publicPrefix.length) || null;
  const privatePrefix = ownerUserId ? `model-provider:${ownerUserId}:` : null;
  if (privatePrefix && accountIdentity.startsWith(privatePrefix)) {
    return accountIdentity.slice(privatePrefix.length) || null;
  }
  return null;
}

export function threadRuntimeBackendKey(
  ownerUserId: string,
  realm: string,
  viewId: string,
  outerThreadId: string,
  executionProfile: Partial<ExecutionProfile> | null = null,
): string {
  const plane = realm === "workspace" ? viewId : "local";
  const base = `${ownerUserId}\0${realm}\0${plane}\0outer:${outerThreadId}`;
  return executionProfile?.fingerprint
    ? `${base}\0profile:${executionProfile.fingerprint}`
    : base;
}

export function backendInitializeParams(connection: RoutingConnection): AppServerParams {
  const requested = isRecord(connection.initializeParams) ? connection.initializeParams : {};
  const capabilities = Reflect.get(requested, "capabilities");
  const requestedCapabilities = isRecord(capabilities) ? capabilities : {};
  const { optOutNotificationMethods: _outerOptOut, ...sharedCapabilities } = requestedCapabilities;
  return {
    ...requested,
    clientInfo: connection.clientInfo ?? { name: "hypernode", version: "0.1" },
    capabilities: { ...sharedCapabilities, experimentalApi: true },
  };
}

function pick(
  object: ProtocolRecord,
  keys: readonly string[],
): ProtocolRecord {
  const result: ProtocolRecord = {};
  for (const key of keys) {
    if (object[key] !== undefined) result[key] = object[key];
  }
  return result;
}

function isRecord(value: unknown): value is ProtocolRecord {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
