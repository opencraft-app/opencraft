import type { JsonRpcResponse } from "./appserver.ts";
import type {
  TransparentBackendState,
  TransparentForwardedRequest,
  TransparentInternalRequest,
} from "./transparent-backend.ts";

export interface TransparentBackendMessageHost {
  observe(message: JsonRpcResponse): void;
  handleBootstrap(message: JsonRpcResponse): boolean;
  handleAccount(message: JsonRpcResponse): boolean;
  observeRuntime(message: JsonRpcResponse): boolean;
  deferUntilBinding(message: JsonRpcResponse): boolean;
  handleProcess(message: JsonRpcResponse): boolean;
  completeInternalControl(message: JsonRpcResponse): boolean;
  consumeAbandoned(message: JsonRpcResponse): boolean;
  takeInternal(message: JsonRpcResponse): TransparentInternalRequest | null;
  handleInternal(message: JsonRpcResponse, request: TransparentInternalRequest): boolean;
  takeForwarded(message: JsonRpcResponse): TransparentForwardedRequest | null;
  handleForwarded(message: JsonRpcResponse, request: TransparentForwardedRequest): void;
  handleUnmatchedResponse(message: JsonRpcResponse): void;
  handleServerRequest(message: JsonRpcResponse): void;
  handleNotification(message: JsonRpcResponse): void;
}

export interface TransparentBackendMessagePort {
  handle(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    host: TransparentBackendMessageHost,
  ): void;
}
