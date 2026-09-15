import type { TransparentBackendState } from "./transparent-backend.ts";

export interface TransparentRuntimeRetirementResult {
  retired: number;
  deferred: number;
}

/**
 * Owns Runtime retirement policy only. Durable Thread history, Runtime
 * location and process mechanics remain separate authorities.
 */
export interface TransparentRuntimeRetirementPort {
  closeArchivedWorkspaceBackend(
    outerThreadId: string,
    candidate: TransparentBackendState | null | undefined,
  ): void;
  retireIsolatedBackend(
    state: TransparentBackendState | null | undefined,
    outerThreadId: string,
    strict: boolean,
  ): boolean;
  retireThreadRuntimeIfIdle(outerThreadId: string): boolean;
  retireIdleUserBackends(userId: string): TransparentRuntimeRetirementResult;
}
