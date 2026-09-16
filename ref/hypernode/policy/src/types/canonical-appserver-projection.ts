import type {
  CanonicalEventSource,
  CanonicalParams,
  CanonicalRecordResult,
  CanonicalTurnSeed,
} from "./canonical-timeline.js";
import type {
  AppServerConnection,
  AppServerParams,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./appserver.js";

export interface AppServerProjectedNotification {
  method: string;
  params: CanonicalParams;
}

export interface AppServerHistoryItem {
  id?: string | null;
  type?: string;
  [key: string]: unknown;
}

export interface AppServerHistoryTurn {
  id: string;
  items?: AppServerHistoryItem[];
  itemsView?: string;
  [key: string]: unknown;
}

export interface AppServerHistoryThread {
  id: string;
  cwd: string;
  turns?: AppServerHistoryTurn[];
  [key: string]: unknown;
}

export interface AppServerHistoryRequest {
  connection: AppServerConnection;
  message: JsonRpcRequest;
  threadId: string;
}

export interface AppServerActiveModel {
  model?: string | null;
  providerId?: string | null;
}

/**
 * Explicit side effects owned by the Runtime/control-plane boundary.
 *
 * Backend messages passed to the projection service are already translated
 * into the stable outer namespace. The projection therefore cannot learn or
 * persist a Runtime-private thread id by accident.
 */
export interface AppServerBackendProjectionHost {
  virtualPath(path: string): string;
  turnStarted(threadId: string, turn: CanonicalTurnSeed): void;
  turnCompleted(threadId: string, turn: CanonicalTurnSeed | null): void;
  threadArchived(threadId: string): void;
}

/**
 * Compatibility projection from canonical execution facts to AppServer.
 *
 * Engine adapters submit facts through this port.  They never write a
 * renderer read model or broadcast a Desktop notification on their own.
 */
export interface AppServerProjectionPort {
  prepare(
    method: string,
    params: CanonicalParams,
    source?: CanonicalEventSource,
  ): AppServerProjectedNotification;
  broadcast(
    method: string,
    params: CanonicalParams,
    source?: CanonicalEventSource,
  ): CanonicalRecordResult;
  historyResult(
    method: string,
    thread: AppServerHistoryThread,
    params?: AppServerParams,
    activeModel?: AppServerActiveModel | null,
  ): unknown;
  handleHistory(
    request: AppServerHistoryRequest,
  ): true;
  projectBackend(
    message: JsonRpcResponse,
    host: AppServerBackendProjectionHost,
  ): string | null;
  projectThread(
    threadId: string,
    source: unknown,
    host: AppServerBackendProjectionHost,
  ): void;
}
