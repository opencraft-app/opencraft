import type {
  AppServerConnection,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./appserver.ts";
import type { ExecutionProfile, RuntimeExecutionHint } from "../services/execution-profile.ts";
import type { EngineKind } from "./domain.ts";
import type { TransparentBackendState } from "./transparent-backend.ts";

export type TransparentHandoffPhase = "quiescing" | "snapshotting" | "resuming";

export interface TransparentHandoffCredential {
  userId: string;
  accountIdentity: string | null;
  providerId?: string | null | undefined;
}

export interface TransparentHandoffAuthority {
  epoch: number;
}

export interface TransparentHandoffBinding {
  innerThreadId: string;
  realm: TransparentBackendState["realm"];
  viewId: string;
  rolloutPath?: string | null | undefined;
  [key: string]: unknown;
}

export interface TransparentHandoffArtifact {
  threadId: string;
  innerThreadId: string;
  parentInnerThreadId?: string | undefined;
  reidentified?: boolean | undefined;
  generation: number;
  parentGeneration?: number | null | undefined;
  path: string;
  previous?: unknown;
  status?: string | undefined;
  resumeHistory?: unknown[] | null | undefined;
  resumeMode?: "history" | "path" | undefined;
  persistent?: boolean | undefined;
  transformStats?: {
    parsedLines: number;
    strippedResponseItemIds: number;
    providerChanged: boolean;
  } | undefined;
}

export interface TransparentEngineSwitch {
  connection: AppServerConnection;
  outerThreadId: string;
  message: JsonRpcRequest;
  actorCredential: TransparentHandoffCredential;
  executionProfile: ExecutionProfile | null;
  authority: TransparentHandoffAuthority;
  binding: TransparentHandoffBinding;
  runtimeHint: RuntimeExecutionHint;
  oldState: TransparentBackendState | null;
  reject(reason: string, code?: number): void;
  phase: TransparentHandoffPhase;
  reidentify: boolean;
  artifact?: TransparentHandoffArtifact | undefined;
  resumeRoute?: Readonly<Record<string, unknown>> | undefined;
}

export interface TransparentEngineSwitchStart {
  connection: AppServerConnection;
  outerThreadId: string;
  message: JsonRpcRequest;
  actorCredential: TransparentHandoffCredential;
  backendUserId: string;
  executionProfile: ExecutionProfile | null;
  reject(reason: string, code?: number): void;
}

export interface TransparentEngineSwitchArtifactInput {
  outerThreadId: string;
  rolloutPath: string;
  epoch: number;
  innerThreadId: string;
  reidentify: boolean;
  modelProvider: string;
}

export interface TransparentEngineSwitchPort {
  begin(input: TransparentEngineSwitchStart): void;
  continue(handoff: TransparentEngineSwitch): void;
}

export interface TransparentHandoffBindingRuntime {
  ownerUserId: string;
  accountIdentity: string | null;
  providerId: string | null;
  engineKind: EngineKind;
  model: string | null;
  rolloutPath: string;
  backendKey: string;
  epoch: number;
  nextProviderId?: undefined;
  nextModel?: undefined;
  nextThreadSettings?: undefined;
}

export interface TransparentHandoffHost {
  discardArtifact(artifact: TransparentHandoffArtifact): void;
  retireIsolatedBackend(state: TransparentBackendState, outerThreadId: string): boolean;
  retry(handoff: TransparentEngineSwitch): void;
  setBinding(
    outerThreadId: string,
    innerThreadId: string,
    realm: TransparentBackendState["realm"],
    viewId: string,
    runtime: TransparentHandoffBindingRuntime,
  ): void;
  commitArtifact(
    artifact: TransparentHandoffArtifact,
    accountIdentity: string | null,
    epoch: number,
    ownerUserId: string,
  ): void;
  unsubscribe(state: TransparentBackendState, innerThreadId: string): void;
  projectThread(outerThreadId: string, thread: unknown): void;
  flushThreadMessages(innerThreadId: string): void;
  discardUnmatchedThreadMessages(): void;
  forwardTurn(
    state: TransparentBackendState,
    connection: AppServerConnection,
    outerThreadId: string,
    message: JsonRpcRequest,
  ): void;
}

export interface TransparentHandoffPort {
  handle(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    handoff: TransparentEngineSwitch | undefined,
    host: TransparentHandoffHost,
  ): boolean;
}
