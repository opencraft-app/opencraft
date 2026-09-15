import type { JsonRpcResponse } from "./appserver.ts";
import type { TransparentBackendState } from "./transparent-backend.ts";

export interface TransparentExecutionSnapshot {
  epoch: number;
  runtimeId?: string | null | undefined;
}

export interface TransparentRuntimeAuthoritySnapshot {
  runtimeId?: string | null | undefined;
}

export interface TransparentIngressAuthorityPort {
  outerThreadId(innerThreadId: string): string | null;
  activeExecution(outerThreadId: string): TransparentExecutionSnapshot | null;
  runtimeAuthority(outerThreadId: string): TransparentRuntimeAuthoritySnapshot | null;
  latestEpoch(outerThreadId: string): number | null;
}

export interface TransparentBackendIngressPort {
  backendThreadId(message: JsonRpcResponse): string | null;
  messageTurnId(message: JsonRpcResponse): string | null;
  isStaleAuthorityMessage(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    authority: TransparentIngressAuthorityPort,
  ): boolean;
  deferUntilThreadBinding(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    hasBinding: (innerThreadId: string) => boolean,
  ): boolean;
  takeDeferredThreadMessages(
    state: TransparentBackendState,
    innerThreadId: string,
  ): JsonRpcResponse[];
  discardUnmatchedThreadMessages(state: TransparentBackendState): boolean;
}
