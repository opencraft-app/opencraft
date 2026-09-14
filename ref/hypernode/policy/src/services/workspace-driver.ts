import { Service, type Context } from "@deepseek-ai/cordis";
import type {
  WorkspaceAttachMode,
  WorkspaceDriverPort,
  WorkspaceNativeAttachment,
  WorkspacePrincipal,
  WorkspaceRef,
  WorkspaceRootBinding,
} from "../types/workspace.js";

/**
 * Provider-neutral adapter around the host Workspace resource graph.
 *
 * Policy services consume this port instead of reading host globals. Only
 * Workspace v2 is exposed to policy code.
 */
export class WorkspaceDriverService extends Service implements WorkspaceDriverPort {
  readonly enabled: boolean;

  constructor(ctx: Context) {
    super(ctx, "workspaceDriver");
    this.enabled = globalThis.hostWorkspaces?.enabled === true;
  }

  root(): WorkspaceRootBinding | null {
    return globalThis.hostWorkspaces?.root() ?? null;
  }

  status(): Record<string, unknown> {
    return globalThis.hostWorkspaces?.status() ?? { enabled: false };
  }

  createWorkspace(threadId: string): { workspace: WorkspaceRef; becameRoot: boolean } {
    return this.native().ensureThread(threadId);
  }

  forkWorkspace(sourceThreadId: string, destinationThreadId: string): WorkspaceRef {
    return this.native().forkThread(sourceThreadId, destinationThreadId);
  }

  deleteWorkspace(threadId: string): void {
    if (globalThis.hostWorkspaces?.enabled === true) globalThis.hostWorkspaces.deleteThread(threadId);
  }

  attachWorkspace(
    threadId: string,
    principal: Required<WorkspacePrincipal>,
    mode: WorkspaceAttachMode,
  ): WorkspaceNativeAttachment {
    return this.native().attach(threadId, principal.id, principal.username, mode);
  }

  detachWorkspace(attachmentId: string): void {
    if (globalThis.hostWorkspaces?.enabled === true) globalThis.hostWorkspaces.detach(attachmentId);
  }

  private native() {
    const driver = globalThis.hostWorkspaces;
    if (driver?.enabled !== true) throw new Error("workspace driver is unavailable");
    return driver;
  }
}
