import type { WorkspaceCatalog } from '@opencraft/appserver-protocol';
import type { ComposerExecutionTarget } from '@opencraft/composer-core';
import type { SandboxExecutionTarget } from '@opencraft/chat-core';
import type { DraftWorkspaceOption } from './draft-workspace-model';

/** A complete execution location. Project is an optional association, never its identity. */
export interface WorkspaceChoice {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly environment?: SandboxExecutionTarget;
  readonly workspace: ComposerExecutionTarget['workspace'];
}

export function buildWorkspaceChoices(directories: readonly DraftWorkspaceOption[], catalog?: WorkspaceCatalog): readonly WorkspaceChoice[] {
  const choices: WorkspaceChoice[] = [
    ...directories.map(directory => ({
      id: JSON.stringify(['host', directory.cwd]), label: directory.label, detail: directory.cwd,
      workspace: { cwd: directory.cwd, runtimeWorkspaceRoots: directory.runtimeWorkspaceRoots,
        ...(directory.projectId ? { projectId: directory.projectId } : {}) },
    })),
    ...(catalog?.libraries.flatMap(library => catalog.environments
      .filter(environment => libraryAvailable(catalog, library.id, environment.target))
      .map(environment => ({
        id: JSON.stringify(['library', environment.target.configurationId, environment.target.templateId, library.id]),
        label: library.name, detail: environment.name, environment: environment.target,
        workspace: { cwd: null, runtimeWorkspaceRoots: [], source: {
          version: 1 as const, kind: 'library-reference' as const, libraryId: library.id, relativePath: '',
        } },
      }))) ?? []),
  ];
  const seen = new Set<string>();
  return choices.filter(choice => { if (seen.has(choice.id)) return false; seen.add(choice.id); return true; });
}

export function temporaryWorkspaceChoice(environment?: SandboxExecutionTarget): WorkspaceChoice {
  return { id: JSON.stringify(['temporary', environment?.configurationId, environment?.templateId]),
    label: '', detail: '', environment, workspace: { cwd: null, runtimeWorkspaceRoots: [] } };
}

/** An explicit workspace selection replaces the whole location in one transaction. */
export function selectWorkspaceChoice(execution: ComposerExecutionTarget, choice: WorkspaceChoice, catalog?: WorkspaceCatalog): ComposerExecutionTarget {
  const { environment: _previous, ...target } = execution;
  const next = { ...target, ...(choice.environment ? { environment: choice.environment } : {}), workspace: choice.workspace };
  const problem = placementProblem(next, catalog);
  if (problem) throw new Error(problem);
  return next;
}

export function workspaceChoiceSelected(choice: WorkspaceChoice, execution: ComposerExecutionTarget): boolean {
  const source = execution.workspace.source, candidate = choice.workspace.source;
  return sameEnvironment(choice.environment, execution.environment) && choice.workspace.cwd === execution.workspace.cwd
    && candidate?.kind === source?.kind && candidate?.libraryId === source?.libraryId
    && candidate?.relativePath === source?.relativePath
    && (candidate?.kind !== 'git' || (source?.kind === 'git' && candidate.repositoryId === source.repositoryId && candidate.ref === source.ref));
}

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
