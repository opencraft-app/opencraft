import type { SandboxExecutionTarget } from '@opencraft/chat-core';
export const WORKSPACE_PLACEMENT_EXTENSION = 'opencraft/workspace-placement';
export const WORKSPACE_CATALOG_METHOD = 'workspace/catalog/read';
export interface WorkspaceCatalog {
  readonly version: 1;
  readonly environments: readonly {target: SandboxExecutionTarget; name: string; status:'configured';
    resources:{cpuMillis:number;memoryBytes:number}}[];
  readonly libraries: readonly {id:string;name:string;status:'configured'|'unavailable';environmentIds:readonly string[]}[];
}
export function supportsWorkspacePlacement(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as {version?:unknown}).version === 1;
}

export const WORKSPACE_FILE_SCOPE_METHOD = 'workspace/files/scope';
/** Server-owned routing projection, not a grant and never a client mount path. */
export type WorkspaceFileLocation = { readonly kind: 'host' } | {
  readonly kind: 'workspace'; readonly threadId: string; readonly root: string;
};

export function supportsWorkspaceFiles(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as {fileScopeVersion?:unknown}).fileScopeVersion === 1;
}

/** Server-owned starting boundary for the existing Workbench directory picker. */
export function workspaceProjectDirectoryRoot(value: unknown): string | undefined {
  const root = value && typeof value === 'object' ? (value as {projectDirectoryRoot?:unknown}).projectDirectoryRoot : undefined;
  return typeof root === 'string' && root.startsWith('/') && !/[\\\x00-\x1f\x7f]/u.test(root) ? root : undefined;
}
