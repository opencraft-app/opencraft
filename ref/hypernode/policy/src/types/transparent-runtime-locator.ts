import type { AppServerConnection, JsonRpcId } from "./appserver.ts";
import type { TransparentBackendState } from "./transparent-backend.ts";
import type { RuntimeFilesystemPort } from "./workspace.ts";
import type { ExecutionProfile } from "../services/execution-profile.ts";
import type { TransparentTurnCredential } from "./transparent-turn-execution.ts";

export interface TransparentExecutionAuthority {
  connection: AppServerConnection;
  epoch: number;
  threadId?: string | undefined;
  actorUserId?: string | undefined;
  actorUsername?: string | undefined;
  startedAtMs?: number | undefined;
  runtimeId?: string | null | undefined;
  turnId?: string | null | undefined;
  executionProfile?: ExecutionProfile | null | undefined;
}

export interface TransparentExecutionChange {
  type: string;
  execution: TransparentExecutionAuthority & { threadId: string };
  reason?: string | null;
}

export interface TransparentExecutionLookupPort {
  readonly orphanedAttempts: Array<{
    executionId: string;
    threadId: string;
    epoch: number;
    turnId: string;
    runtimeId?: string | null | undefined;
    state: "orphaned";
  }>;
  readonly table: {
    get(threadId: string): TransparentExecutionAuthority | null | undefined;
    values(): IterableIterator<TransparentExecutionAuthority>;
    runtimeAuthority(threadId: string): { runtimeId?: string | null | undefined } | null;
    latestEpoch(threadId: string): number | null;
    seedEpoch(threadId: string, epoch: number): unknown;
  };
  onChange(listener: (event: TransparentExecutionChange) => void): () => boolean;
}

export interface TransparentExecutionCompletionOptions {
  connection?: AppServerConnection | null | undefined;
  turnId?: string | null | undefined;
  epoch?: number | undefined;
  reason?: string | undefined;
}

/** Mutable execution lifecycle used only by Runtime coordination services. */
export interface TransparentExecutionLifecyclePort {
  claimRequest(
    threadId: string,
    credential: TransparentTurnCredential,
    connection: AppServerConnection,
    requestId: JsonRpcId | undefined,
    executionProfile: ExecutionProfile,
  ): TransparentExecutionAuthority | null;
  abortRequest(
    threadId: string,
    connection: AppServerConnection,
    requestId: JsonRpcId | undefined,
    reason?: string,
  ): unknown;
  abortRuntime(runtimeId: string, reason?: string): Array<{
    threadId: string;
    turnId?: string | null | undefined;
  }>;
  bindTurn(
    threadId: string,
    connection: AppServerConnection,
    turnId: string | null | undefined,
    epoch?: number,
  ): unknown;
  bindRuntime(
    threadId: string,
    connection: AppServerConnection,
    runtimeId: string,
    innerThreadId: string | undefined,
    epoch?: number,
    runtimeFingerprint?: string | null,
  ): unknown;
  markNativeStarted(
    threadId: string,
    connection: AppServerConnection,
    nativeTurnId: string | null | undefined,
    epoch?: number,
  ): unknown;
  complete(threadId: string, options?: TransparentExecutionCompletionOptions): unknown;
  releaseThread(threadId: string, reason?: string): unknown;
}

/**
 * Resolves durable public Thread identity to the currently live Runtime.
 *
 * This is deliberately a lookup-only port. Runtime lifecycle, durable
 * bindings and AppServer projection remain separate authorities.
 */
export interface TransparentRuntimeLocatorPort {
  ownerConnection(
    state: Pick<TransparentBackendState, "backendKey"> | null | undefined,
    outerThreadId: string,
  ): AppServerConnection | null;
  ownerEpoch(
    state: Pick<TransparentBackendState, "backendKey"> | null | undefined,
    outerThreadId: string,
  ): number | undefined;
  stateForOuter(
    outerThreadId: string,
    localFilesystem: RuntimeFilesystemPort,
  ): TransparentBackendState | null;
}
