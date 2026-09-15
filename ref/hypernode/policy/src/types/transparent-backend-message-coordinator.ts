import type { JsonRpcResponse } from "./appserver.ts";
import type {
  TransparentBackendState,
  TransparentInternalRequest,
} from "./transparent-backend.ts";
import type { TransparentBackendBootstrapHost } from "./transparent-backend.ts";
import type { TransparentForwardedResponseHost } from "./transparent-forwarded-response.ts";

/**
 * Remaining compatibility-facade effects needed by native Runtime ingress.
 *
 * Correlation, account state, Runtime observation and outbound dispatch are
 * deliberately absent: the typed coordinator owns those responsibilities.
 */
export interface TransparentBackendMessageCoordinatorHost {
  bootstrap: TransparentBackendBootstrapHost;
  handleInternal(message: JsonRpcResponse, request: TransparentInternalRequest): boolean;
  forwardedResponseHost(): TransparentForwardedResponseHost;
}

export interface TransparentBackendMessageCoordinatorPort {
  handle(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    host: TransparentBackendMessageCoordinatorHost,
  ): void;
  flushDeferred(
    state: TransparentBackendState,
    innerThreadId: string,
    host: TransparentBackendMessageCoordinatorHost,
  ): void;
}
