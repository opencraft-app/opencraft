import type { VirtualWebSocket } from "../runtime/virtual-websocket.ts";
import type { PresentationMetadata } from "../services/websocket-presentation-queue.ts";

export type JsonRpcId = string | number | null;

export interface AppServerCapabilities {
  experimentalApi?: boolean;
  "hypernode.sync.v1"?: boolean;
  /** Product-owned capabilities negotiated without mutating generated ABI. */
  extensions?: Record<string, unknown>;
}

export interface AppServerParams extends Record<string, unknown> {
  capabilities?: AppServerCapabilities;
}

export interface JsonRpcRequest {
  id?: JsonRpcId;
  method?: string;
  params?: AppServerParams;
}

export interface JsonRpcResponse {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface AppServerDeferredController {
  resolve(result: unknown): void;
  reject(error: unknown): void;
}

export interface AppServerDeferredResult {
  readonly __hypernodeDeferredRpc: true;
  start(controller: AppServerDeferredController): void;
}

export interface AppServerClientInfo {
  name?: string;
  title?: string;
  version?: string;
  [key: string]: unknown;
}

export interface AppServerIdentity {
  id?: string;
  username?: string;
  [key: string]: unknown;
}

export interface FilesystemWatch {
  path: string;
  routable?: boolean;
  drain?(): string[];
  stop?(): void;
}

export type FilesystemWatchRegistration = string | FilesystemWatch;

export interface PendingNotification {
  method: string;
  params: unknown;
  sensitive: boolean;
}

export interface DeferredAction {
  dueAtMs: number;
  action(): void;
}

export interface ThreadExecutionAbortPort {
  abortRequest(
    threadId: string,
    connection: AppServerConnection,
    requestId: JsonRpcId | undefined,
    reason: string,
  ): unknown;
}

export interface ThreadWriteLeaseReleasePort {
  release(threadId: string, connection: AppServerConnection): void;
  releaseThread?(threadId: string): void;
}

export interface AppServerConnection {
  clientInfo: AppServerClientInfo | null;
  initializeParams: AppServerParams | null;
  initialized: boolean;
  pendingNotifications: PendingNotification[];
  deferredActions: DeferredAction[];
  socket: VirtualWebSocket;
  watches: Map<string, FilesystemWatchRegistration>;
  unroutableWatchPaths: Set<string>;
  identity: AppServerIdentity | null;
  connectionId: string | null;
  sessionId: string | null;
  activeThreadId?: string | null;
  threadCatalogStatuses?: Map<string, string>;
  threadPresentationNames?: Map<string, string>;
  threadExecution?: ThreadExecutionAbortPort;
  threadWriteLease?: ThreadWriteLeaseReleasePort;
  threadTombstoneReplay?: {
    replayedAtMs: number;
    replayedCount: number;
    replayedThroughSeq: number;
    checkpointed: boolean;
    checkpointedAtMs?: number;
  };
}

export interface AppServerAttachMetadata {
  identity?: AppServerIdentity | null;
  connectionId?: string | null;
  sessionId?: string | null;
  [key: string]: unknown;
}

export type AppServerHandler = (
  params: AppServerParams,
  connection: AppServerConnection,
) => unknown | AppServerDeferredResult;

export type AppServerInterceptor = (
  message: JsonRpcRequest | null,
  connection: AppServerConnection,
) => boolean | void;

export type AppServerProjector = (
  message: JsonRpcResponse,
  connection: AppServerConnection,
) => JsonRpcResponse | null | undefined;

export type AppServerConnectionListener = (connection: AppServerConnection) => void;
export type AppServerInitializeListener = (
  connection: AppServerConnection,
  client: AppServerClientInfo,
) => void;
export type AppServerResponseListener = (
  connection: AppServerConnection,
  request: JsonRpcRequest,
  result: unknown,
) => void;

export interface AppServerRuntimePort {
  readonly connections: Iterable<AppServerConnection>;
  filesystemWatchSequence: number;
  tick(now?: number): void;
  attach(socket: VirtualWebSocket, metadata?: AppServerAttachMetadata): void;
  send(connection: AppServerConnection, message: JsonRpcResponse, sensitive?: boolean): void;
  intercept(handler: AppServerInterceptor): () => boolean;
  onInitialize(listener: AppServerInitializeListener): () => boolean;
  onAfterResponse(listener: AppServerResponseListener): () => boolean;
  onClose(listener: AppServerConnectionListener): () => boolean;
  projectOutbound(handler: AppServerProjector): () => boolean;
  notifyAfter(
    connection: AppServerConnection,
    method: string,
    params: unknown,
    options?: { sensitive?: boolean },
  ): void;
  notifyAllAfter(
    origin: AppServerConnection,
    method: string,
    params: unknown,
    options?: { sensitive?: boolean },
  ): void;
  broadcastNotification(
    method: string,
    params: unknown,
    options?: { sensitive?: boolean },
  ): void;
  defer(connection: AppServerConnection, delayMs: number, action: () => void): void;
  afterPresentationDrained(metadata: PresentationMetadata, action: () => void): boolean;
  summarizeResult(result: unknown): Record<string, unknown>;
  audit(
    connection: AppServerConnection,
    type: string,
    payload: Record<string, unknown>,
  ): void;
}
