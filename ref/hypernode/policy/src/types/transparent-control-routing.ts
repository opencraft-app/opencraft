import type {
  AppServerConnection,
  AppServerParams,
  JsonRpcRequest,
} from "./appserver.ts";
import type {
  TransparentBackendState,
} from "./transparent-backend.ts";
import type {
  TransparentInternalControlRequest,
  TransparentProcessFilesystemPort,
} from "./transparent-process.ts";
import type { RuntimeFilesystemPort } from "./workspace.ts";

export type TransparentControlRoutingFilesystemPort =
  RuntimeFilesystemPort & TransparentProcessFilesystemPort;

export interface TransparentControlRoutingPort {
  requestUserBackend(
    connection: AppServerConnection,
    method: string,
    params: AppServerParams | undefined,
    callback: TransparentInternalControlRequest["callback"],
  ): void;
  ensureCodexControlBackend(
    connection: AppServerConnection,
    ownerUserId: string,
  ): TransparentBackendState;
  resetCodexControlBackend(ownerUserId: string): boolean;
  forwardInternalControlNow(
    state: TransparentBackendState,
    request: TransparentInternalControlRequest,
  ): void;
  queueControl(
    connection: AppServerConnection,
    message: JsonRpcRequest,
  ): void;
  stateForControl(
    connection: AppServerConnection,
    message: JsonRpcRequest,
  ): TransparentBackendState | null;
  forwardControlNow(
    state: TransparentBackendState,
    connection: AppServerConnection,
    message: JsonRpcRequest,
  ): void;
}
