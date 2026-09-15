import type { RuntimeId, ThreadId, TurnId } from "./domain.js";
import type { AppServerConnection, JsonRpcRequest } from "./appserver.ts";
import type { RuntimeFilesystemPort } from "./workspace.ts";
import type { ExecutionProfile } from "../services/execution-profile.ts";
import type { TransparentTurnCredential } from "./transparent-turn-execution.ts";

export interface EngineRpcError {
  message?: string;
}
export type EngineRpcCallback = (error?: EngineRpcError | null, result?: unknown) => void;

export type EngineRpcRequest = (
  method: string,
  params: Record<string, string>,
  callback: EngineRpcCallback,
) => void;

export interface EngineQuiesceHandlers {
  ready(): void;
  error(error: Error): void;
}

export interface EngineRuntimeNotification {
  method?: string;
  params?: {
    threadId?: unknown;
    thread?: { id?: unknown };
    turn?: { id?: unknown };
  };
}

export interface EngineRuntimeWaiter {
  runtimeId: string;
  threadId: string;
  request: EngineRpcRequest;
  handlers: EngineQuiesceHandlers;
  phase: "draining" | "unsubscribing";
  deadlineAtMs: number;
}

export interface EngineRuntimeControlPort {
  quiesce(
    runtimeId: RuntimeId | string,
    threadId: ThreadId | string,
    request: EngineRpcRequest,
    handlers: EngineQuiesceHandlers,
    now?: number,
  ): EngineRuntimeWaiter;
  observe(runtimeId: RuntimeId | string, message: EngineRuntimeNotification): boolean;
  tick(now?: number): void;
}

export interface EngineTurnIdentity {
  runtimeId: RuntimeId;
  threadId: ThreadId;
  turnId: TurnId;
}

export interface EngineThreadPreparation {
  threadId: string;
  profile: ExecutionProfile;
  credential: TransparentTurnCredential | null;
  /** Client that owns presentation capabilities for a prewarmed Runtime. */
  connection?: AppServerConnection | undefined;
  filesystem: RuntimeFilesystemPort;
  viewId: string;
  cwd: string | null;
  prewarm?: boolean | undefined;
}

export interface EngineTurnStart extends EngineThreadPreparation {
  connection: AppServerConnection;
  message: JsonRpcRequest;
  suppressResponse?: boolean | undefined;
}

export interface EngineTurnControl {
  connection: AppServerConnection;
  threadId: string;
  message: JsonRpcRequest;
}

export interface DshRuntimeUser {
  username?: string | null;
  linuxUid?: number | null;
  linuxGid?: number | null;
  installationId?: string | null;
}

export interface DshRuntimeDrainResult {
  stdoutLines?: string[];
  stderrLines?: string[];
  exited?: boolean;
  exitCode?: number;
  error?: string;
}

export interface DshRuntimeHostPort {
  start(processId: string, user: DshRuntimeUser | null, providerId: string): void;
  send(processId: string, message: string | Record<string, unknown>): void;
  drain(processId: string): DshRuntimeDrainResult;
  stop(processId: string, timeoutMs?: number): void;
}

/** Concrete DSH adapter capability, kept behind the generic engine router. */
export interface DshEngineAdapterPort {
  supports(profile: ExecutionProfile): boolean;
  hasThread(threadId: string): boolean;
  retireThread(threadId: string): boolean;
  prepareThread(input: EngineThreadPreparation): unknown;
  startTurn(input: EngineTurnStart): unknown;
  steer(input: EngineTurnControl): void;
  interrupt(input: EngineTurnControl): void;
}

/** Engine-neutral port consumed by AppServer admission and Turn routing. */
export interface ExecutionEnginePort {
  supports(profile: ExecutionProfile): boolean;
  hasThread(threadId: string): boolean;
  retireThread(threadId: string): boolean;
  prepareThread(input: EngineThreadPreparation): unknown;
  startTurn(input: EngineTurnStart): unknown;
  steer(input: EngineTurnControl): void;
  interrupt(input: EngineTurnControl): void;
}
