import { Service, type Context } from "@deepseek-ai/cordis";
import type { AppServerConnection, JsonRpcResponse } from "../types/appserver.ts";
import type {
  TransparentBackendRpcPort,
  TransparentBackendState,
  TransparentForwardedRequest,
  TransparentInternalRequest,
  TransparentServerRequestRoute,
} from "../types/transparent-backend.ts";

function responseKey(message: JsonRpcResponse): string | null {
  return message.id === undefined || message.method !== undefined
    ? null
    : String(message.id);
}

/**
 * Owns transient JSON-RPC correlation state for one backend process.
 *
 * It deliberately knows nothing about Thread projection or execution policy:
 * callers receive the original typed request and decide the business result.
 */
export class TransparentBackendRpcService extends Service implements TransparentBackendRpcPort {
  constructor(ctx: Context) {
    super(ctx, "transparentBackendRpc");
  }

  trackInternal(
    state: TransparentBackendState,
    backendId: string,
    request: TransparentInternalRequest,
  ): void {
    state.internalRequests.set(backendId, request);
  }

  takeInternal(
    state: TransparentBackendState,
    message: JsonRpcResponse,
  ): TransparentInternalRequest | null {
    const key = responseKey(message);
    if (key === null) return null;
    const request = state.internalRequests.get(key) ?? null;
    if (request !== null) state.internalRequests.delete(key);
    return request;
  }

  trackForwarded(
    state: TransparentBackendState,
    backendId: string,
    request: TransparentForwardedRequest,
  ): void {
    state.forwardedRequests.set(backendId, request);
  }

  takeForwarded(
    state: TransparentBackendState,
    message: JsonRpcResponse,
  ): TransparentForwardedRequest | null {
    const key = responseKey(message);
    if (key === null) return null;
    const request = state.forwardedRequests.get(key) ?? null;
    if (request !== null) state.forwardedRequests.delete(key);
    return request;
  }

  completeInternalControl(
    state: TransparentBackendState,
    message: JsonRpcResponse,
  ): boolean {
    const key = responseKey(message);
    if (key === null) return false;
    const request = state.internalControlRequests.get(key);
    if (request === undefined) return false;
    state.internalControlRequests.delete(key);
    request.callback(message.error ?? null, message.result ?? null, state);
    return true;
  }

  consumeAbandoned(state: TransparentBackendState, message: JsonRpcResponse): boolean {
    const key = responseKey(message);
    return key !== null && state.abandonedRequestIds.delete(key);
  }

  trackServerRequest(
    state: TransparentBackendState,
    publicId: string,
    route: TransparentServerRequestRoute,
  ): void {
    state.serverRequestIds.set(publicId, route);
  }

  takeServerResponse(
    state: TransparentBackendState,
    connection: AppServerConnection,
    message: JsonRpcResponse,
  ): TransparentServerRequestRoute | null {
    const key = responseKey(message);
    if (key === null) return null;
    const route = state.serverRequestIds.get(key);
    if (route === undefined || route.connection !== connection) return null;
    state.serverRequestIds.delete(key);
    return route;
  }

  abandonConnection(state: TransparentBackendState, connection: AppServerConnection): void {
    for (const [id, request] of state.forwardedRequests) {
      if (request.connection !== connection) continue;
      if (request.method === "turn/steer") {
        console.info(`[turn-steer] ${JSON.stringify({
          stage: "connection-abandoned",
          outerThreadId: request.outerThreadId,
          connectionId: connection.connectionId ?? null,
          sessionId: connection.sessionId ?? null,
          frontendRequestId: request.clientId ?? null,
          clientUserMessageId: request.clientUserMessageId ?? null,
          expectedTurnId: request.expectedTurnId ?? null,
          backendId: id,
          pendingMs: request.forwardedAtMs === undefined
            ? null
            : Math.max(0, Date.now() - request.forwardedAtMs),
        })}`);
      }
      state.forwardedRequests.delete(id);
      state.abandonedRequestIds.add(id);
    }
    for (const [id, route] of state.serverRequestIds) {
      if (route.connection === connection) state.serverRequestIds.delete(id);
    }
  }
}
