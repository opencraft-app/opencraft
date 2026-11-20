import type { WorkspaceCatalog } from '@opencraft/appserver-protocol';
import type { ComposerExecutionTarget } from '@opencraft/composer-core';
import type { SandboxExecutionTarget, WorkspaceSource } from '@opencraft/chat-core';

export function sameEnvironment(a: SandboxExecutionTarget | undefined, b: SandboxExecutionTarget | undefined): boolean {
  return a?.configurationId === b?.configurationId && a?.templateId === b?.templateId;
}
export function libraryAvailable(catalog: WorkspaceCatalog, id: string, environment: SandboxExecutionTarget): boolean {
  return catalog.libraries.some(library => library.id === id && library.status === 'configured'
    && library.environmentIds.includes(environment.configurationId));
}
export function placementProblem(execution: ComposerExecutionTarget, catalog: WorkspaceCatalog | undefined): string | null {
  if (!execution.environment && !execution.workspace.source) return null;
  if (!catalog || !execution.environment || !catalog.environments.some(entry => sameEnvironment(entry.target, execution.environment)))
    return 'The selected environment is unavailable. Refresh or choose another environment.';
  const source = execution.workspace.source;
  if (source?.libraryId && !libraryAvailable(catalog, source.libraryId, execution.environment))
    return 'The selected source is unavailable in this environment. Choose another source or explicitly use an empty workspace.';
  return null;
}
/** Selections are atomic. Never discard an incompatible source as a side effect. */
export function selectPlacementEnvironment(execution: ComposerExecutionTarget, environment: SandboxExecutionTarget | undefined,
  catalog: WorkspaceCatalog): ComposerExecutionTarget {
  if (sameEnvironment(execution.environment, environment)) return execution;
  if (execution.workspace.projectId || execution.workspace.source || execution.workspace.cwd !== null || execution.workspace.runtimeWorkspaceRoots.length) {
    if (!environment || execution.workspace.projectId || (execution.workspace.source?.kind === 'git' && !execution.workspace.source.libraryId) || execution.workspace.cwd !== null || execution.workspace.runtimeWorkspaceRoots.length
      || placementProblem({ ...execution, environment }, catalog))
      throw new Error('Keep your current selection, or explicitly choose an empty workspace before changing environment.');
  }
  const next = { ...execution, environment, workspace: { ...execution.workspace, cwd: null, runtimeWorkspaceRoots: [] } };
  const problem = placementProblem(next, catalog);
  if (problem) throw new Error(problem);
  return next;
}
export function selectPlacementSource(execution: ComposerExecutionTarget, source: WorkspaceSource | undefined,
  catalog: WorkspaceCatalog): ComposerExecutionTarget {
  const next = { ...execution, workspace: { cwd: null, runtimeWorkspaceRoots: [], ...(source ? { source } : {}) } };
  const problem = placementProblem(next, catalog);
  if (problem) throw new Error(problem);
  return next;
}
