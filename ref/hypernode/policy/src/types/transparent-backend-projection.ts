import type { JsonRpcResponse } from "./appserver.ts";
import type { TransparentBackendState } from "./transparent-backend.ts";

export interface TransparentBackendProjectionPort {
  projectThread(
    outerThreadId: string,
    source: unknown,
    state: TransparentBackendState | null | undefined,
  ): void;
  projectBackend(
    message: JsonRpcResponse,
    state: TransparentBackendState | null | undefined,
  ): void;
}
