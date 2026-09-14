import { Service, type Inject } from "@deepseek-ai/cordis";
import type { AppServerConnection, AppServerParams } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  RuntimeFilesystemPort,
  RuntimeWorkspacePort,
  WorkspaceForkProjection,
  WorkspaceRuntimeRecord,
  WorkspaceRuntimeThread,
} from "../types/workspace.ts";

type Dependencies = "workspaceFilesystem" | "workspaceView";

/**
 * Selects a logical Workspace and its execution filesystem without exposing
 * the concrete Docker/runc/host implementation to an execution engine.
 */
export class RuntimeWorkspaceService extends Service implements RuntimeWorkspacePort {
  static inject = ["workspaceFilesystem", "workspaceView"] satisfies Inject<
    Pick<HypernodeServices, Dependencies>
  >;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "runtimeWorkspace");
  }

  get enabled(): boolean {
    return this.ctx.workspaceFilesystem.enabled;
  }

  get supportsPersistentRuntimeFencing(): boolean {
    return this.ctx.workspaceFilesystem.supportsPersistentRuntimeFencing === true;
  }

  defaultFilesystem(local: RuntimeFilesystemPort): RuntimeFilesystemPort {
    return this.enabled ? this.ctx.workspaceFilesystem : local;
  }

  filesystemForCwd(
    cwd: string | null,
    local: RuntimeFilesystemPort,
  ): RuntimeFilesystemPort | null {
    if (typeof cwd !== "string") return null;
    if (this.enabled && this.ctx.workspaceFilesystem.owns(cwd)) {
      return this.ctx.workspaceFilesystem;
    }
    return local.owns(cwd) ? local : null;
  }

  filesystemForRealm(
    realm: "workspace" | "localhost",
    local: RuntimeFilesystemPort,
  ): RuntimeFilesystemPort {
    return realm === "workspace" && this.enabled ? this.ctx.workspaceFilesystem : local;
  }

  isWorkspaceFilesystem(filesystem: RuntimeFilesystemPort): boolean {
    return filesystem.enabled === true && filesystem.mount === "/workspace";
  }

  prepareStartParams(params: AppServerParams): AppServerParams {
    return this.ctx.workspaceView.prepareStartParams(params);
  }

  bindMain(thread: WorkspaceRuntimeThread): void {
    this.ctx.workspaceView.bindMain(thread);
  }

  recordFor(threadId: string): WorkspaceRuntimeRecord | null {
    return this.ctx.workspaceView.recordFor(threadId);
  }

  viewIdForThread(threadId: string): string {
    return this.ctx.workspaceView.viewIdForThread(threadId);
  }

  assertRuntimeAvailable(threadId: string): void {
    this.ctx.workspaceView.assertRuntimeAvailable(threadId);
  }

  projectsRoot(viewId?: string): string {
    return viewId === undefined
      ? this.ctx.workspaceView.projectsRoot()
      : this.ctx.workspaceView.projectsRoot(viewId);
  }

  fork(
    params: AppServerParams,
    connection: AppServerConnection,
    options?: { notify?: boolean | undefined },
  ): WorkspaceForkProjection {
    return options === undefined
      ? this.ctx.workspaceView.fork(params, connection)
      : this.ctx.workspaceView.fork(params, connection, options);
  }

  archive(thread: WorkspaceRuntimeThread): void {
    this.ctx.workspaceView.archive(thread);
  }

  discardFork(threadId: string): void {
    this.ctx.workspaceView.discardFork(threadId);
  }

  terminateThreadRuntime(
    processId: string,
    viewId: string,
    threadId: string,
    timeoutMs: number,
  ): void {
    this.ctx.workspaceFilesystem.terminateThreadRuntime(
      processId,
      viewId,
      threadId,
      timeoutMs,
    );
  }
}
