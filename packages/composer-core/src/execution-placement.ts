import {
  isSandboxExecutionTarget as isComposerSandboxTarget,
  isWorkspaceSource as isComposerWorkspaceSource,
} from "@opencraft/chat-core";
export {
  isSandboxExecutionTarget as isComposerSandboxTarget,
  isWorkspaceSource as isComposerWorkspaceSource,
  isWorkspaceRelativePath,
} from "@opencraft/chat-core";
export type {
  SandboxExecutionTarget as ComposerSandboxTarget,
  WorkspaceSource as ComposerWorkspaceSource,
} from "@opencraft/chat-core";
/** Extra placement metadata must never be silently stripped by draft hydration. */
export function assertComposerPlacement(execution: {
  readonly environment?: unknown;
  readonly workspace: {
    readonly cwd: unknown;
    readonly runtimeWorkspaceRoots: readonly unknown[];
    readonly source?: unknown;
  };
}): void {
  if (
    (execution.environment !== undefined && !isComposerSandboxTarget(execution.environment)) ||
    (execution.workspace.source !== undefined && !isComposerWorkspaceSource(execution.workspace.source))
  )
    throw new Error("Invalid execution placement");
  // Native paths belong to Host-local placement. Remote cwd is server-resolved.
  if (
    (execution.environment !== undefined || execution.workspace.source !== undefined) &&
    (execution.workspace.cwd !== null || execution.workspace.runtimeWorkspaceRoots.length !== 0)
  )
    throw new Error("Logical placement cannot contain native workspace paths");
}
