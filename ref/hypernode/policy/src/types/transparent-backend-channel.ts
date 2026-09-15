import type { AppServerConnection, JsonRpcResponse } from "./appserver.ts";
import type { TransparentBackendState } from "./transparent-backend.ts";

export interface TransparentBackendChannelHost {
  hasBinding(innerThreadId: string): boolean;
  outerThreadId(innerThreadId: string): string | null;
  replay(state: TransparentBackendState, message: JsonRpcResponse): void;
}

export interface TransparentBackendChannelPort {
  nextServerRequestId(): string;
  isStaleAuthorityMessage(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    host: TransparentBackendChannelHost,
  ): boolean;
  deferUntilThreadBinding(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    host: TransparentBackendChannelHost,
  ): boolean;
  flushThreadMessages(
    state: TransparentBackendState,
    innerThreadId: string,
    host: TransparentBackendChannelHost,
  ): void;
  discardUnmatchedThreadMessages(state: TransparentBackendState): boolean;
  send(
    connection: AppServerConnection,
    message: JsonRpcResponse,
    sensitive?: boolean,
  ): void;
  broadcast(state: TransparentBackendState, message: JsonRpcResponse): void;
  subscribe(connection: AppServerConnection, outerThreadId: string): void;
  unsubscribe(connection: AppServerConnection, outerThreadId: string): boolean;
  removeConnection(connection: AppServerConnection): string[];
  broadcastCatalog(
    method: string,
    threadId: string,
    message?: JsonRpcResponse | null,
    now?: number,
  ): boolean;
}
