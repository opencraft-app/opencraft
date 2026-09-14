import type {
  AppServerConnection,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./appserver.ts";
import type {
  TransparentCommandProcess,
  TransparentHostProcess,
  TransparentInternalControlRequest,
  TransparentProcessState,
} from "./transparent-process.ts";
import type { ExecutionProfile } from "../services/execution-profile.ts";
import type { TransparentEngineSwitch } from "./transparent-handoff.ts";
import type { RuntimeFilesystemPort } from "./workspace.ts";

export type TransparentBackendPhase = "initializing" | "ready" | "failed" | "closed";

export interface TransparentBackendDrainResult {
  stdoutLines?: string[] | undefined;
  stderrLines?: string[] | undefined;
  exited?: boolean | undefined;
  exitCode?: number | undefined;
  error?: string | undefined;
}

export interface TransparentBackendFilesystemPort extends RuntimeFilesystemPort {
  normalize(path: string): string;
  drain(processId: string): TransparentBackendDrainResult;
}

export interface TransparentForwardedRequest {
  connection: AppServerConnection;
  clientId: JsonRpcRequest["id"];
  outerThreadId: string | null;
  method?: string | undefined;
  backendId?: string | undefined;
  forwardedAtMs?: number | undefined;
  clientUserMessageId?: string | null | undefined;
  expectedTurnId?: string | null | undefined;
  authorityEpoch?: number | undefined;
  name?: string | undefined;
  commandProcess?: TransparentCommandProcess | null | undefined;
  hostProcess?: TransparentHostProcess | null | undefined;
  workspaceFork?: boolean | undefined;
  forkOuterThreadId?: string | undefined;
  localForkResponse?: unknown;
}

export interface TransparentInternalRequest {
  outerThreadId: string;
  method: string;
  handoff?: TransparentEngineSwitch | undefined;
}

export interface TransparentServerRequestRoute {
  innerId: JsonRpcRequest["id"];
  connection: AppServerConnection;
}

export interface TransparentPendingOuterAction {
  connection: AppServerConnection;
  message: JsonRpcRequest;
  respondFromOpen?: boolean | undefined;
}

export interface TransparentBackendState extends TransparentProcessState {
  ownerUserId: string;
  accountIdentity: string | null;
  providerId: string | null;
  executionProfile: ExecutionProfile | null;
  runtimeFingerprint: string | null;
  backendKey: string;
  isolatedOuterThreadId: string | null;
  realm: "workspace" | "localhost";
  filesystem: TransparentBackendFilesystemPort;
  phase: TransparentBackendPhase;
  initId: string;
  internalRequests: Map<string, TransparentInternalRequest>;
  forwardedRequests: Map<string, TransparentForwardedRequest>;
  serverRequestIds: Map<string, TransparentServerRequestRoute>;
  pendingByOuter: Map<string, TransparentPendingOuterAction[]>;
  openResults: Map<string, unknown>;
  opened: Set<string>;
  opening: Set<string>;
  ephemeralOuterIds: Map<AppServerConnection, Set<string>>;
  turnEpochs: Map<string, number>;
  stderr: string[];
  pendingControl: Array<{ connection: AppServerConnection; message: JsonRpcRequest }>;
  pendingInternalControl: TransparentInternalControlRequest[];
  pendingBackendMessages: JsonRpcRequest[];
  pendingThreadMessages: Map<string, JsonRpcResponse[]>;
  abandonedRequestIds: Set<string>;
  commandProcesses: Map<string, TransparentCommandProcess>;
  commandProcessesByConnection: Map<AppServerConnection, Map<string, TransparentCommandProcess>>;
  hostProcesses: Map<string, TransparentHostProcess>;
  hostProcessesByConnection: Map<AppServerConnection, Map<string, TransparentHostProcess>>;
}

export interface TransparentBackendInput {
  ownerUserId: string;
  accountIdentity: string | null;
  providerId: string | null;
  executionProfile: ExecutionProfile | null;
  runtimeFingerprint: string | null;
  backendKey: string;
  isolatedOuterThreadId: string | null;
  realm: "workspace" | "localhost";
  viewId: string;
  filesystem: TransparentBackendFilesystemPort;
  user: unknown;
  connection: AppServerConnection;
  processId: string;
  initId: string;
}

export interface TransparentBackendCredential {
  accountIdentity: string | null;
  providerId: string | null;
}

export interface TransparentBackendEnsureOptions {
  backendKey?: string | undefined;
  isolatedOuterThreadId?: string | null | undefined;
  accountIdentity?: string | null | undefined;
  providerId?: string | null | undefined;
  executionProfile?: ExecutionProfile | null | undefined;
}

export interface TransparentBackendEnsureInput {
  connection: AppServerConnection;
  ownerUserId: string;
  filesystem: TransparentBackendFilesystemPort;
  viewId: string;
  initialCwd: string | null;
  defaultBackendKey: string;
  workspaceRealm: boolean;
  options?: TransparentBackendEnsureOptions | undefined;
}

export interface TransparentBackendReadyWork {
  backendMessages: JsonRpcRequest[];
  controls: Array<{ connection: AppServerConnection; message: JsonRpcRequest }>;
  internalControls: TransparentInternalControlRequest[];
  outerThreadIds: string[];
}

export interface TransparentBackendRegistryPort {
  readonly backends: Map<string, TransparentBackendState>;
  readonly connections: Map<AppServerConnection, Set<TransparentBackendState>>;
  create(input: TransparentBackendInput): TransparentBackendState;
  attach(state: TransparentBackendState, connection: AppServerConnection): void;
  remove(state: TransparentBackendState): boolean;
  detachConnection(state: TransparentBackendState, connection: AppServerConnection): void;
}

export interface TransparentBackendLifecyclePort {
  ensure(input: TransparentBackendEnsureInput): TransparentBackendState;
  completeInitialization(state: TransparentBackendState): TransparentBackendReadyWork | null;
  fail(state: TransparentBackendState, reason: string): boolean;
  closeProcess(
    state: TransparentBackendState,
    runtimeId: string | null,
  ): boolean;
  retireIsolated(
    state: TransparentBackendState | null | undefined,
    outerThreadId: string,
    strict?: boolean,
  ): boolean;
}

export interface TransparentBackendRpcPort {
  trackInternal(
    state: TransparentBackendState,
    backendId: string,
    request: TransparentInternalRequest,
  ): void;
  takeInternal(
    state: TransparentBackendState,
    message: JsonRpcResponse,
  ): TransparentInternalRequest | null;
  trackForwarded(
    state: TransparentBackendState,
    backendId: string,
    request: TransparentForwardedRequest,
  ): void;
  takeForwarded(
    state: TransparentBackendState,
    message: JsonRpcResponse,
  ): TransparentForwardedRequest | null;
  completeInternalControl(
    state: TransparentBackendState,
    message: JsonRpcResponse,
  ): boolean;
  consumeAbandoned(state: TransparentBackendState, message: JsonRpcResponse): boolean;
  trackServerRequest(
    state: TransparentBackendState,
    publicId: string,
    route: TransparentServerRequestRoute,
  ): void;
  takeServerResponse(
    state: TransparentBackendState,
    connection: AppServerConnection,
    message: JsonRpcResponse,
  ): TransparentServerRequestRoute | null;
  abandonConnection(state: TransparentBackendState, connection: AppServerConnection): void;
}

export interface TransparentBackendPumpHandlers {
  message(message: JsonRpcResponse): void;
  failed(reason: string): void;
}

export interface TransparentBackendPumpPort {
  poll(state: TransparentBackendState, handlers: TransparentBackendPumpHandlers): void;
}

export interface TransparentBackendBootstrapHost {
  fail(reason: string): void;
  forwardControl(connection: AppServerConnection, message: JsonRpcRequest): void;
  forwardInternalControl(request: TransparentInternalControlRequest): void;
  openOuter(outerThreadId: string): void;
  failOuter(outerThreadId: string, reason: string): void;
}

export interface TransparentBackendBootstrapPort {
  handle(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    host: TransparentBackendBootstrapHost,
  ): boolean;
}
