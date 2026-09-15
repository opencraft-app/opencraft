import type { EngineKind, JsonValue } from "./domain.ts";
import type { PolicyStorePort } from "./storage.ts";
import type { RuntimeExecutionHint } from "../services/execution-profile.ts";

export type TransparentThreadRealm = "localhost" | "workspace";

export interface TransparentThreadBinding {
  innerThreadId: string;
  durable: boolean;
  realm: TransparentThreadRealm;
  viewId: string;
  rolloutPath: string | null;
}

export interface TransparentRuntimeHint extends RuntimeExecutionHint {
  ownerUserId: string | null;
  accountIdentity: string | null;
  engineKind: EngineKind;
  providerId: string | null;
  model: string | null;
  threadSettings: Record<string, JsonValue> | null;
  backendKey: string | null;
  epoch: number | null;
  nextProviderId?: string | null | undefined;
  nextModel?: string | null | undefined;
  nextThreadSettings?: Record<string, JsonValue> | null | undefined;
}

export interface TransparentRuntimeUpdate {
  rolloutPath?: string | null;
  ownerUserId?: string | null;
  accountIdentity?: string | null;
  engineKind?: EngineKind;
  providerId?: string | null;
  model?: string | null;
  threadSettings?: Record<string, JsonValue> | null;
  backendKey?: string | null;
  epoch?: number | null;
  nextProviderId?: string | null | undefined;
  nextModel?: string | null | undefined;
  nextThreadSettings?: Record<string, JsonValue> | null | undefined;
}

export interface TransparentBindingArtifact {
  threadId: string;
  innerThreadId: string;
  generation?: number | undefined;
  path?: string | null | undefined;
  ownerUserId?: string | null | undefined;
  accountIdentity?: string | null | undefined;
  epoch?: number | null | undefined;
}

export interface TransparentBindingHost {
  principalId: string;
  policyStore: Pick<PolicyStorePort, "get" | "set">;
  artifacts: {
    current(threadId: string): TransparentBindingArtifact | null;
    values(): Iterable<TransparentBindingArtifact>;
  };
  threads: {
    find(threadId: string): { id: string; cwd?: string | null } | null;
    isTransparentCodex(threadId: string): boolean;
    ownerOf?(threadId: string): string | null;
  };
  workspaceViews: {
    recordFor(threadId: string): { viewId: string } | null;
  };
  users: {
    find(userId: string): unknown;
    list(): Array<{ id?: string | undefined }>;
  };
  credentials: {
    resolveUser(userId: string): { accountIdentity?: string | null } | null;
  };
}

export interface TransparentBindingState {
  bindings: Map<string, TransparentThreadBinding>;
  runtimeHints: Map<string, TransparentRuntimeHint>;
  reverseBindings: Map<string, string>;
}

export interface TransparentThreadBindingPort extends TransparentBindingState {
  persist(): void;
  setBinding(
    outerThreadId: string,
    innerThreadId: string,
    durable?: boolean,
    persist?: boolean,
    realm?: TransparentThreadRealm,
    viewId?: string,
    runtime?: TransparentRuntimeUpdate,
  ): void;
  setRuntimeHint(
    outerThreadId: string,
    runtime: TransparentRuntimeUpdate,
    persist?: boolean,
  ): void;
  runtimeHintFor(outerThreadId: string): TransparentRuntimeHint | null;
  clearBinding(outerThreadId: string): void;
  promoteBinding(outerThreadId: string): void;
  describe(): Array<{
    outerThreadId: string;
    innerThreadId: string;
    durable: boolean;
    realm: TransparentThreadRealm;
    viewId: string;
    rolloutPath: string | null;
    lastRuntimeHint: TransparentRuntimeHint | null;
  }>;
}
