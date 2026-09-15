import type {
  JsonRpcResponse,
} from "./appserver.ts";
import type { TransparentBackendState } from "./transparent-backend.ts";

export interface TransparentBackendOutboundPort {
  handleServerRequest(
    state: TransparentBackendState,
    message: JsonRpcResponse,
  ): void;
  handleNotification(
    state: TransparentBackendState,
    message: JsonRpcResponse,
  ): void;
}
