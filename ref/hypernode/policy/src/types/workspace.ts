import type { EngineKind, ThreadId, ViewId } from "./domain.js";
import type {
  AppServerConnection,
  AppServerParams,
  JsonRpcRequest,
} from "./appserver.ts";
import type { ThreadLifecycleThread } from "./thread-lifecycle.ts";
import type { HostTerminalAttachment, TerminalDrainResult } from "./host-policy.ts";

export type WorkspaceAttachMode = "readOnly" | "readWrite";

export interface WorkspaceRef {
  id: string;
  driver: string;
}

export interface WorkspaceRootBinding {
  threadId: string;
  workspace: WorkspaceRef;
}

export interface WorkspaceEndpoint {
  transport?: string;
  host: string;
  port: number;
  username?: string;
  subsystem?: string;
}

export interface WorkspaceNativeAttachment {
  id: string;
  workspace?: WorkspaceRef;
  endpoint: WorkspaceEndpoint;
}

export interface WorkspacePrincipal {
  id?: string;
  username?: string;
}

export interface WorkspaceFilesystemPort {
  readonly mount?: string;
  owns(path: string): boolean;
}

/**
 * Filesystem capability required by an execution engine.
 *
 * The implementation may be the host-local VFS, a Workspace v2 attachment,
 * or a future remote sandbox.  Callers must not infer the concrete driver
 * from the object identity.
 */
export interface RuntimeFilesystemPort extends WorkspaceFilesystemPort {
  readonly enabled?: boolean;
  /** Whether a runtime can survive the host process and therefore needs
   * driver-level fencing in addition to terminating its host process. */
  readonly supportsPersistentRuntimeFencing?: boolean;
  toPhysical(path: string, user?: unknown, viewId?: string): string;
  toVirtual(path: string, user?: unknown, viewId?: string): string;
  ensureWorkingDirectory(path: string, user?: unknown, viewId?: string): string;
  spawnAppServer(
    processId: string,
    cwd: string,
    user: unknown,
    viewId: string,
    providerId: string | null,
  ): void;
  spawnThreadRuntime(
    processId: string,
    cwd: string,
    user: unknown,
    viewId: string,
    threadId: string,
    providerId: string | null,
  ): void;
  send(processId: string, message: JsonRpcRequest): void;
  drain(processId: string): {
    stdoutLines?: string[] | undefined;
    stderrLines?: string[] | undefined;
    exited?: boolean | undefined;
    exitCode?: number | undefined;
    error?: string | undefined;
  };
  kill(processId: string): void;
  terminateThreadRuntime(
    processId: string,
    viewId: string,
    threadId: string,
    timeoutMs: number,
  ): void;
}

/** Host-local execution filesystem before public `/workspace/.codex` aliasing. */
export interface LocalRuntimeFilesystemPort extends RuntimeFilesystemPort {
  readonly physicalRoot: string;
  normalize(path: string): string;
  createDirectory(
    params: { path: string; recursive?: boolean },
    user?: unknown,
  ): unknown;
  writeFile(
    params: { path: string },
    bytes: ArrayLike<number>,
    user?: unknown,
  ): unknown;
  spawnDshEngineWorker?(
    processId: string,
    cwd: string,
    user: unknown,
    providerId: string | null,
  ): void;
}

export interface WorkspaceRuntimeThread {
  readonly id: string;
  cwd: string;
  readonly ephemeral?: boolean | undefined;
  readonly forkedFromId?: string | null | undefined;
  readonly [key: string]: unknown;
}

export interface WorkspaceRuntimeRecord {
  readonly threadId: string;
  readonly viewId: string;
  readonly kind: string;
  readonly sourceThreadId?: string | null | undefined;
  readonly deleted?: boolean | undefined;
  readonly state?: string | undefined;
  readonly deletedAtMs?: number | undefined;
  readonly destroyedAtMs?: number | undefined;
}

export interface WorkspaceForkProjection {
  readonly thread: WorkspaceRuntimeThread;
  readonly [key: string]: unknown;
}

/** Raw capability exposed by the concrete Workspace filesystem service. */
export interface WorkspaceRuntimeFilesystemPort extends RuntimeFilesystemPort {
  readonly enabled: boolean;
  readonly mount: string;
  readonly v2: boolean;
  attachmentFor(viewId?: string): WorkspaceAttachmentHandle | null;
}

/** Raw capability exposed by the concrete Workspace view service. */
export interface WorkspaceViewPort {
  prepareStartParams(params: AppServerParams): AppServerParams;
  prepareResumeCwd(threadId: string, cwd: string): string;
  bindMain(thread: WorkspaceRuntimeThread): void;
  recordFor(threadId: string): WorkspaceRuntimeRecord | null;
  viewIdForThread(threadId: string): string;
  assertRuntimeAvailable(threadId: string): void;
  assertRestorable(threadId: string): void;
  projectsRoot(viewId?: string): string;
  fork(
    params: AppServerParams,
    connection: AppServerConnection,
    options?: { notify?: boolean | undefined },
  ): WorkspaceForkProjection;
  archive(thread: WorkspaceRuntimeThread): void;
  discardFork(threadId: string): void;
  bindLeaseAlias(threadId: string, viewId?: string): void;
  unbindLeaseAlias(threadId: string): void;
}

/**
 * Engine-facing Workspace port.  This is the only Workspace surface the
 * transparent execution layer is allowed to consume.
 */
export interface RuntimeWorkspacePort {
  readonly enabled: boolean;
  readonly supportsPersistentRuntimeFencing: boolean;
  defaultFilesystem(local: RuntimeFilesystemPort): RuntimeFilesystemPort;
  filesystemForCwd(cwd: string | null, local: RuntimeFilesystemPort): RuntimeFilesystemPort | null;
  filesystemForRealm(
    realm: "workspace" | "localhost",
    local: RuntimeFilesystemPort,
  ): RuntimeFilesystemPort;
  isWorkspaceFilesystem(filesystem: RuntimeFilesystemPort): boolean;
  prepareStartParams(params: AppServerParams): AppServerParams;
  bindMain(thread: WorkspaceRuntimeThread): void;
  recordFor(threadId: string): WorkspaceRuntimeRecord | null;
  viewIdForThread(threadId: string): string;
  assertRuntimeAvailable(threadId: string): void;
  projectsRoot(viewId?: string): string;
  fork(
    params: AppServerParams,
    connection: AppServerConnection,
    options?: { notify?: boolean | undefined },
  ): WorkspaceForkProjection;
  archive(thread: WorkspaceRuntimeThread): void;
  discardFork(threadId: string): void;
  terminateThreadRuntime(
    processId: string,
    viewId: string,
    threadId: string,
    timeoutMs: number,
  ): void;
}

export interface WorkspaceAttachmentInput {
  threadId: ThreadId | string;
  engineId: EngineKind | string;
  viewId?: ViewId | string;
  cwd: string;
  filesystem: WorkspaceFilesystemPort;
  principal?: WorkspacePrincipal | string | null;
}

export interface WorkspaceAttachmentHandle {
  readonly id: string;
  readonly threadId: string;
  readonly engineId: string;
  readonly viewId: string;
  readonly cwd: string;
  readonly endpoint: Readonly<WorkspaceEndpoint> | null;
  readonly capabilityId: string | null;
  detach(reason?: string): boolean;
}

export interface WorkspaceAttachmentSnapshot {
  id: string;
  threadId: string;
  engineId: string;
  viewId: string;
  cwd: string;
  endpoint: WorkspaceEndpoint | null;
  references: number;
  attachedAtMs: number;
}

export interface WorkspaceAttachmentPort {
  attach(input: WorkspaceAttachmentInput): WorkspaceAttachmentHandle;
  detach(handle: WorkspaceAttachmentHandle, reason?: string): boolean;
  find(threadId: ThreadId | string, engineId: EngineKind | string): WorkspaceAttachmentHandle | null;
  snapshot(): WorkspaceAttachmentSnapshot[];
}

export interface WorkspaceDriverPort {
  readonly enabled: boolean;
  root(): WorkspaceRootBinding | null;
  status(): Record<string, unknown>;
  createWorkspace(threadId: string): { workspace: WorkspaceRef; becameRoot: boolean };
  forkWorkspace(sourceThreadId: string, destinationThreadId: string): WorkspaceRef;
  deleteWorkspace(threadId: string): void;
  attachWorkspace(
    threadId: string,
    principal: Required<WorkspacePrincipal>,
    mode: WorkspaceAttachMode,
  ): WorkspaceNativeAttachment;
  detachWorkspace(attachmentId: string): void;
}

export interface HostWorkspacesPort {
  readonly enabled: boolean;
  root(): WorkspaceRootBinding | null;
  status(): Record<string, unknown>;
  ensureThread(threadId: string): { workspace: WorkspaceRef; becameRoot: boolean };
  forkThread(sourceThreadId: string, destinationThreadId: string): WorkspaceRef;
  deleteThread(threadId: string): void;
  attach(
    threadId: string,
    principalId: string,
    username: string,
    mode: WorkspaceAttachMode,
  ): WorkspaceNativeAttachment;
  detach(attachmentId: string): void;
  openTerminal(
    terminalId: string,
    capabilityId: string,
    cols: number,
    rows: number,
  ): HostTerminalAttachment;
  writeTerminal(terminalId: string, bytes: Uint8Array): void;
  resizeTerminal(terminalId: string, cols: number, rows: number): void;
  drainTerminal(terminalId: string): TerminalDrainResult;
  closeTerminal(terminalId: string): void;
}

export interface WorkspaceThread {
  id: string;
  cwd?: string | null;
  ephemeral?: boolean;
}

export interface WorkspaceThreadMetadata {
  kind?: string;
  workspaceSourceThreadId?: string | null;
}

export interface WorkspaceThreadManagerPort {
  onCreate(
    listener: (thread: WorkspaceThread, metadata?: WorkspaceThreadMetadata | null) => void,
  ): () => void;
  addArchiveGuard(listener: (threadId: string) => void): () => void;
}

export interface RootThreadPort {
  get(): ThreadLifecycleThread;
  is(threadId: string): boolean;
}
