import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.js";
import type {
  WorkspaceDriverPort,
  WorkspaceRef,
  WorkspaceRootBinding,
  WorkspaceThread,
  WorkspaceThreadMetadata,
} from "../types/workspace.js";

export function ordinaryWorkspaceThread(
  thread: WorkspaceThread | null | undefined,
  metadata?: WorkspaceThreadMetadata | null,
): boolean {
  if (!thread) return false;
  const kind = metadata?.kind ?? "";
  return thread.ephemeral !== true && !["management", "all"].includes(kind) &&
    typeof thread.cwd === "string" && thread.cwd.startsWith("/workspace");
}

export class WorkspaceRootMigrationRequiredError extends Error {
  readonly code = -32073;
  readonly data: {
    kind: "workspaceRootMigrationRequired";
    currentThreadId: string;
    requiredThreadId: string;
  };

  constructor(currentThreadId: string, requiredThreadId: string) {
    super(
      `workspace root ${currentThreadId} does not match node root thread ${requiredThreadId}; ` +
      "explicit migration is required",
    );
    this.name = "WorkspaceRootMigrationRequiredError";
    this.data = { kind: "workspaceRootMigrationRequired", currentThreadId, requiredThreadId };
  }
}

export class RootWorkspaceArchiveDeniedError extends Error {
  readonly code = -32072;
  readonly data: { kind: "rootWorkspaceArchiveDenied"; threadId: string };

  constructor(threadId: string) {
    super("root workspace conversation cannot be archived");
    this.name = "RootWorkspaceArchiveDeniedError";
    this.data = { kind: "rootWorkspaceArchiveDenied", threadId };
  }
}

export function establishWorkspaceRoot(
  workspaceDriver: Pick<WorkspaceDriverPort, "root" | "createWorkspace">,
  rootThreadId: string,
): WorkspaceRootBinding {
  if (!rootThreadId) throw new Error("node root thread id is required");
  const durable = workspaceDriver.root();
  if (durable?.threadId && durable.threadId !== rootThreadId) {
    throw new WorkspaceRootMigrationRequiredError(durable.threadId, rootThreadId);
  }
  if (!durable) workspaceDriver.createWorkspace(rootThreadId);
  const established = workspaceDriver.root();
  if (established?.threadId !== rootThreadId) {
    throw new Error(`failed to establish node root workspace for thread ${rootThreadId}`);
  }
  return established;
}

export function allocateWorkspaceForThread(
  workspaceDriver: Pick<WorkspaceDriverPort, "forkWorkspace">,
  rootThreadId: string,
  thread: WorkspaceThread,
  metadata?: WorkspaceThreadMetadata | null,
): WorkspaceRef | null {
  if (!ordinaryWorkspaceThread(thread, metadata)) return null;
  const sourceThreadId = metadata?.workspaceSourceThreadId ?? rootThreadId;
  return workspaceDriver.forkWorkspace(sourceThreadId, thread.id);
}

// WorkspaceRootService owns only two invariants:
//   1. the node-shared HyperNode management Thread is the stable root reference;
//   2. every ordinary workspace Thread is a fork of that root (or an explicit
//      source Thread), never a competing root candidate.
// Root identity belongs to RootThreadService and is persisted at node scope.
// This service only binds that identity to the workspace resource graph.
export class WorkspaceRootService extends Service {
  static inject = ["appServer", "rootThread", "threadManager", "workspaceDriver"] satisfies Inject<
    Pick<HypernodeServices, "appServer" | "rootThread" | "threadManager" | "workspaceDriver">
  >;

  readonly enabled: boolean;
  readonly rootThreadId: string;

  constructor(ctx: HypernodeContext<"appServer" | "rootThread" | "threadManager" | "workspaceDriver">) {
    super(ctx, "workspaceRoot");
    this.enabled = ctx.workspaceDriver.enabled;
    this.rootThreadId = ctx.rootThread.get().id;
    if (!this.enabled) return;

    establishWorkspaceRoot(ctx.workspaceDriver, this.rootThreadId);

    ctx.effect(() => ctx.threadManager.onCreate((thread, metadata) => {
      allocateWorkspaceForThread(ctx.workspaceDriver, this.rootThreadId, thread, metadata);
    }));

    ctx.effect(() => ctx.threadManager.addArchiveGuard((threadId) => {
      if (threadId === this.rootThreadId) {
        throw new RootWorkspaceArchiveDeniedError(threadId);
      }
      ctx.workspaceDriver.deleteWorkspace(threadId);
    }));

    ctx.effect(() => ctx.appServer.register("hypernode/workspace/root/read", () => ({
      threadId: this.rootThreadId,
      root: ctx.workspaceDriver.root(),
    })));
  }

}
