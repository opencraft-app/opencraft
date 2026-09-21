import type {
  AppServerConnection,
  AppServerParams,
  JsonRpcRequest,
} from "./appserver.ts";
import type { TransparentBackendState } from "./transparent-backend.ts";

export interface TransparentOuterDispatchPort {
  open(
    state: TransparentBackendState,
    outerThreadId: string,
    forceStart?: boolean,
  ): void;
  flush(
    state: TransparentBackendState,
    outerThreadId: string,
  ): void;
  forward(
    state: TransparentBackendState,
    connection: AppServerConnection,
    outerThreadId: string,
    message: JsonRpcRequest,
  ): void;
}

export type TransparentOpenSettings = AppServerParams;
