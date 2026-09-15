import type { AppServerConnection, JsonRpcRequest, JsonRpcResponse } from "./appserver.ts";
import type {
  TransparentBackendState,
  TransparentInternalRequest,
} from "./transparent-backend.ts";

/**
 * Effects not yet owned by typed services while an internal Runtime response
 * is converged. Durable bindings and rollout artifacts are deliberately absent.
 */
export interface TransparentInternalResponseCoordinatorHost {
  retireIsolatedBackend(state: TransparentBackendState, outerThreadId: string): boolean;
  unsubscribe(state: TransparentBackendState, innerThreadId: string): void;
  replayBackendMessage(state: TransparentBackendState, message: JsonRpcResponse): void;
  forwardTurn(
    state: TransparentBackendState,
    connection: AppServerConnection,
    outerThreadId: string,
    message: JsonRpcRequest,
  ): void;
  failOuter(outerThreadId: string, reason: string): void;
  openOuter(outerThreadId: string, forceStart: boolean): void;
  flushOpenQueue(outerThreadId: string): void;
}

export interface TransparentInternalResponseCoordinatorPort {
  handle(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    request: TransparentInternalRequest,
    host: TransparentInternalResponseCoordinatorHost,
  ): boolean;
}
