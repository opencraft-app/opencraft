import type {
  JsonRpcResponse,
} from "./appserver.ts";
import type {
  TransparentBackendState,
  TransparentForwardedRequest,
} from "./transparent-backend.ts";

export interface TransparentForwardedResponseHost {
  completeWorkspaceFork(
    request: TransparentForwardedRequest,
    state: TransparentBackendState,
    message: JsonRpcResponse,
  ): boolean;
  closeArchivedWorkspaceBackend(threadId: string, state: TransparentBackendState): void;
}

export interface TransparentForwardedResponsePort {
  handle(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    request: TransparentForwardedRequest,
    host: TransparentForwardedResponseHost,
  ): void;
}
