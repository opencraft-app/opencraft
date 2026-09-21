import type { AppServerConnection, JsonRpcResponse } from "./appserver.ts";
import type { TransparentBackendState } from "./transparent-backend.ts";

/**
 * Owns one native backend's ingress loop and all recursive message replay.
 *
 * Keeping this boundary independent from the JavaScript compatibility facade
 * prevents bootstrap, handoff and fork callbacks from becoming an implicit
 * second runtime implementation.
 */
export interface TransparentBackendSessionPort {
  poll(connection: AppServerConnection): void;
  pollBackend(state: TransparentBackendState): void;
  handleMessage(state: TransparentBackendState, message: JsonRpcResponse): void;
  flushDeferred(state: TransparentBackendState, innerThreadId: string): void;
  failOuter(state: TransparentBackendState, outerThreadId: string, reason: string): void;
  fail(state: TransparentBackendState, reason: string): void;
}
