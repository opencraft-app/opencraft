import type {
  AppServerConnection,
  AppServerParams,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./appserver.ts";

export interface TransparentProcessFilesystemPort {
  normalize(path: string): string;
  owns(path: string): boolean;
  ensureWorkingDirectory(path: string, user: unknown, viewId: string): string;
  send(processId: string, message: JsonRpcRequest): void;
}

export interface TransparentCommandProcess {
  connection: AppServerConnection;
  clientProcessId: string;
  backendProcessId: string;
}

export interface TransparentHostProcess {
  connection: AppServerConnection;
  clientProcessHandle: string;
  backendProcessHandle: string;
  clientCwd: string | null;
  virtualCwd: string | null;
  physicalCwd: string | null;
}

export interface TransparentInternalControlRequest {
  method?: string | undefined;
  params?: AppServerParams | undefined;
  callback(
    error: JsonRpcResponse["error"] | null,
    result?: unknown,
    state?: TransparentProcessState,
  ): void;
}

export interface TransparentProcessState {
  processId: string;
  phase: string;
  user: unknown;
  viewId: string;
  connections: Set<AppServerConnection>;
  commandProcesses: Map<string, TransparentCommandProcess>;
  commandProcessesByConnection: Map<AppServerConnection, Map<string, TransparentCommandProcess>>;
  hostProcesses: Map<string, TransparentHostProcess>;
  hostProcessesByConnection: Map<AppServerConnection, Map<string, TransparentHostProcess>>;
  internalControlRequests: Map<string, TransparentInternalControlRequest>;
}

export interface PreparedCommandRequest {
  message: JsonRpcRequest;
  commandProcess: TransparentCommandProcess | null;
}

export interface PreparedHostProcessRequest {
  message: JsonRpcRequest;
  hostProcess: TransparentHostProcess | null;
}

export interface RoutedProcessNotification {
  handled: boolean;
  connection?: AppServerConnection;
  message?: JsonRpcResponse;
}

export interface TransparentProcessBridgePort {
  prepareCommandRequest(
    state: TransparentProcessState,
    connection: AppServerConnection,
    message: JsonRpcRequest,
    filesystem: TransparentProcessFilesystemPort,
  ): PreparedCommandRequest | null;
  prepareHostProcessRequest(
    state: TransparentProcessState,
    connection: AppServerConnection,
    message: JsonRpcRequest,
    filesystem: TransparentProcessFilesystemPort,
  ): PreparedHostProcessRequest | null;
  releaseCommandProcess(
    state: TransparentProcessState,
    process: TransparentCommandProcess | null | undefined,
  ): void;
  releaseHostProcess(
    state: TransparentProcessState,
    process: TransparentHostProcess | null | undefined,
  ): void;
  routeCommandOutput(
    state: TransparentProcessState,
    message: JsonRpcResponse,
    project: (message: JsonRpcResponse) => JsonRpcResponse,
  ): RoutedProcessNotification;
  routeHostProcessNotification(
    state: TransparentProcessState,
    message: JsonRpcResponse,
    project: (message: JsonRpcResponse) => JsonRpcResponse,
  ): RoutedProcessNotification;
  closeConnectionProcesses(
    state: TransparentProcessState,
    connection: AppServerConnection,
    filesystem: TransparentProcessFilesystemPort,
  ): void;
}

export function rpcParams(message: JsonRpcRequest | JsonRpcResponse): AppServerParams {
  const params = message.params;
  return typeof params === "object" && params !== null && !Array.isArray(params)
    ? params as AppServerParams
    : {};
}

export function rpcId(message: JsonRpcRequest): JsonRpcId | undefined {
  return message.id;
}
