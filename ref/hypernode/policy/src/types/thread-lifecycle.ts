import type {
  AppServerConnection,
  AppServerIdentity,
  AppServerParams,
  ThreadWriteLeaseReleasePort,
} from "./appserver.ts";
import type {
  CanonicalTurnSeed,
} from "./canonical-timeline.js";
import type { ProjectedThreadState } from "./appserver-projection.js";
import type { WorkspaceRuntimeThread } from "./workspace.js";
import type { TransparentTurnRoute } from "./transparent-turn-execution.ts";
import type {
  CodexFallbackSource,
  CodexProfileSource,
  ExecutionProfileSelection,
  ModelProviderRecord,
  SubscriptionSelectionResult,
} from "./account-config.ts";
import type { HostUserRecord } from "./host-policy.ts";
import type { ThreadSection, ThreadTitlePort } from "./thread-metadata.ts";

export interface ThreadLifecyclePrincipal {
  id: string;
  username?: string;
  [key: string]: unknown;
}

export interface ThreadLifecycleThread extends
  ProjectedThreadState,
  WorkspaceRuntimeThread {
  id: string;
  cwd: string;
  status: { type: string; [key: string]: unknown };
  modelProvider?: string;
  projectId?: string | null;
  gitInfo?: unknown;
  turns?: CanonicalTurnSeed[];
  updatedAt?: number;
  recencyAt?: number;
  ephemeral?: boolean;
  forkedFromId?: string | null;
  section?: ThreadSection | null;
  sectionEnteredAt?: number | null;
}

export interface ThreadLifecycleManagerPort {
  create(
    params?: AppServerParams,
    overrides?: Record<string, unknown>,
    metadata?: Record<string, unknown>,
  ): ThreadLifecycleThread;
  find(threadId: string): ThreadLifecycleThread | null;
  get(threadId: string): ThreadLifecycleThread;
  touch(
    threadId: string,
    input?: unknown[],
    metadata?: Record<string, unknown>,
  ): ThreadLifecycleThread;
  changed(threadId: string): void;
  isSystem(threadId: string): boolean;
  isArchived(threadId: string): boolean;
  markRoot(threadId: string): void;
  markSystem(threadId: string, kind: string): void;
  forget(threadId: string): void;
  archive(threadId: string): ThreadLifecycleThread;
  unarchive(threadId: string): ThreadLifecycleThread;
  onArchive(listener: (threadId: string, thread: ThreadLifecycleThread) => void): () => boolean;
  onUnarchive(listener: (threadId: string, thread: ThreadLifecycleThread) => void): () => boolean;
  reconcileInterruptedRuntime(threadId: string): unknown;
  list(params?: AppServerParams): ThreadLifecycleThread[];
  persist(): void;
  persistThread(threadId: string): void;
  setProject(
    threadId: string,
    projectId: string | null,
    options?: { persist?: boolean; touch?: boolean },
  ): ThreadLifecycleThread;
}

export interface ThreadMetadataManagerPort {
  readonly threads: Map<string, ThreadLifecycleThread>;
  persist(): void;
  metadataFor(threadId: string): {
    ownerPrincipalId: string;
    visibility: "private" | "nodeShared";
    kind: string;
    [key: string]: unknown;
  } | null;
  ownerOf(threadId: string): string | null;
  visibleTo(threadId: string, actorPrincipalId: string | null): boolean;
  setVisibility(
    threadId: string,
    visibility: "private" | "nodeShared",
  ): ThreadLifecycleThread;
  attachTitleService(service: ThreadTitlePort): () => void;
  clearSection(sectionId: string): void;
  moveToSection(
    threadId: string,
    section: ThreadSection | null,
    beforeThreadId?: string | null,
  ): ThreadLifecycleThread;
}

export interface PrincipalLifecyclePort {
  current(): ThreadLifecyclePrincipal;
}

export interface ModelGatewayLifecyclePort {
  attachRuntimeRetirer(
    retirer: (userId: string) => { retired: number; deferred: number },
  ): () => void;
  ensureRuntimeProvider(userId: string, providerId: string): unknown;
  visibleRecordsForUser(userId: string | undefined): readonly ModelProviderRecord[];
  currentUser(connection: AppServerConnection): HostUserRecord;
  selectionForUser(userId: string): ExecutionProfileSelection;
  providerForModel(
    userId: string,
    requested: string,
    preferredProviderId?: string | null,
    preferNativeModel?: boolean,
  ): ModelProviderRecord | null;
  observeNativeCodexModels(models: unknown[]): void;
  setDefaultModelForConnection(
    connection: AppServerConnection,
    model: string,
  ): unknown;
  attachCodexProfileSource(source: CodexProfileSource): () => void;
  attachCodexFallbackSource(source: CodexFallbackSource): () => void;
  markCodexProfileActive(
    user: HostUserRecord,
    profileId?: string,
  ): { kind: "codex"; id: string };
  useSubscriptionForUser(
    user: HostUserRecord,
    profileId?: string,
  ): SubscriptionSelectionResult;
  activeForUser(userId: string | undefined): TransparentTurnRoute["provider"] | null;
  activeForConnection(connection: AppServerConnection): {
    model?: string | null;
    providerId?: string | null;
  } | null;
  selectModelForConnection(
    connection: AppServerConnection,
    model: string | null,
  ): TransparentTurnRoute | null;
  selectModelForTurn(
    connection: AppServerConnection,
    model: string | null,
    input: unknown,
  ): TransparentTurnRoute | null;
}

export interface ProjectCatalogLifecyclePort {
  readonly projects: Map<string, ProjectCatalogRecord>;
  persist(): void;
  attachBindingService(service: ProjectBindingCatalogPort): () => void;
  ensureExternal(
    projectId: string,
    cwd?: string | null,
    connection?: AppServerConnection | null,
    options?: { notify?: boolean; persist?: boolean },
  ): ProjectCatalogRecord;
  ensureAuthority(
    root: string,
    connection?: AppServerConnection | null,
    options?: { notify?: boolean; persist?: boolean },
  ): ProjectCatalogRecord;
  forCwd(cwd: string): ProjectCatalogRecord | null;
  get(projectId: string): ProjectCatalogRecord;
  normalizeRoots(roots: Array<{ path?: unknown }>): ProjectCatalogRoot[];
  emit(change: ProjectCatalogChange): void;
}

export interface ProjectCatalogRoot {
  path: string;
}

export interface ProjectCatalogRecord {
  id: string;
  name: string;
  roots: ProjectCatalogRoot[];
  metadata: Record<string, unknown>;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectCatalogChange {
  type: "project";
  connection: AppServerConnection | null;
  projectId: string;
  changeType: "created" | "updated" | "deleted";
}

export interface ThreadProjectBindingChange {
  type: "binding";
  connection: AppServerConnection | null;
  threadId: string;
  projectId: string | null;
}

export interface ProjectBindingCatalogPort {
  assign(
    threadId: string,
    projectId: string | null,
    connection?: AppServerConnection | null,
    options?: { forceNotify?: boolean },
  ): ThreadLifecycleThread;
  clearProject(projectId: string, connection?: AppServerConnection | null): void;
}

export interface ThreadProjectBindingLifecyclePort {
  onChange(listener: (change: ThreadProjectBindingChange) => void): () => boolean;
  capture(
    thread: ThreadLifecycleThread,
    params: AppServerParams,
    connection?: AppServerConnection | null,
    options?: { inferWhenNull?: boolean },
  ): ThreadLifecycleThread;
  assign(
    threadId: string,
    projectId: string | null,
    connection?: AppServerConnection | null,
    options?: { forceNotify?: boolean },
  ): ThreadLifecycleThread;
}

export interface ThreadTombstoneLifecyclePort {
  replay(connection: AppServerConnection): unknown;
  record(threadId: string): unknown;
}

export interface ThreadWriteLeaseLifecyclePort {
  acquire(
    threadId: string,
    connection: ThreadWriteLeaseConnection,
    phase?: string,
  ): ThreadWriteLeaseAcquireResult;
  errorFor(lease: ThreadWriteLeaseRecord): Error;
  release(
    threadId: string,
    connection?: ThreadWriteLeaseConnection | null,
  ): ThreadWriteLeaseRecord | null;
  releaseThread(threadId: string): unknown;
}

export interface ThreadWriteLeaseConnection {
  connectionId: string | null;
  identity: AppServerIdentity | null;
  threadWriteLease?: ThreadWriteLeaseReleasePort;
}

export interface ThreadWriteLeaseRecord {
  threadId: string;
  holderPrincipalId: string;
  holderUsername: string;
  [key: string]: unknown;
}

export interface ThreadWriteLeaseAcquireResult {
  acquired: boolean;
  lease: ThreadWriteLeaseRecord;
}
