import type {
  AppServerConnection,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./appserver.ts";
import type {
  TransparentBackendState,
  TransparentForwardedRequest,
} from "./transparent-backend.ts";

export interface TransparentThreadForkRequest {
  connection: AppServerConnection;
  message: JsonRpcRequest;
}

export interface TransparentThreadForkReplayHost {
  flushThreadMessages(state: TransparentBackendState, innerThreadId: string): void;
}

export interface TransparentThreadForkPort {
  start(request: TransparentThreadForkRequest): void;
  complete(
    forwarded: TransparentForwardedRequest,
    state: TransparentBackendState,
    response: JsonRpcResponse,
    host: TransparentThreadForkReplayHost,
  ): boolean;
}
