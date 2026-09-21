import type { JsonRpcResponse } from "./appserver.ts";
import type { EngineKind } from "./domain.ts";
import type {
  TransparentBackendState,
  TransparentInternalRequest,
} from "./transparent-backend.ts";

export interface TransparentOpenBinding {
  rolloutPath?: string | null | undefined;
}

export interface TransparentOpenRuntimeHint {
  ownerUserId: string;
  accountIdentity: string | null;
  providerId: string | null;
  engineKind: EngineKind;
  model: string | null;
  backendKey: string;
  nextProviderId?: undefined;
  nextModel?: undefined;
  nextThreadSettings?: undefined;
}

export interface TransparentOpenBindingRuntime extends TransparentOpenRuntimeHint {
  rolloutPath: string | null;
}

export interface TransparentBackendOpenHost {
  currentArtifactPath(outerThreadId: string): string | null;
  failOuter(outerThreadId: string, reason: string): void;
  discardUnmatchedThreadMessages(): void;
  clearBinding(outerThreadId: string): void;
  openOuter(outerThreadId: string, forceStart: boolean): void;
  setBinding(
    outerThreadId: string,
    innerThreadId: string,
    durable: boolean,
    realm: TransparentBackendState["realm"],
    viewId: string,
    runtime: TransparentOpenBindingRuntime,
  ): void;
  binding(outerThreadId: string): TransparentOpenBinding | null;
  setRuntimeHint(outerThreadId: string, runtime: TransparentOpenRuntimeHint): void;
  persistBindings(): void;
  projectThread(outerThreadId: string, thread: unknown): void;
  flushThreadMessages(innerThreadId: string): void;
  flushOpenQueue(outerThreadId: string): void;
}

export interface TransparentBackendOpenPort {
  handle(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    internal: TransparentInternalRequest,
    host: TransparentBackendOpenHost,
  ): boolean;
}
