// Route definitions of the per-workspace WorkspaceHost owner, shared by the
// deployment's entry Worker and the WorkspaceHost Durable Object
// (cloudflare-deployment §5.7). Public paths are operator operations on one
// workspace, addressed by its id; the entry Worker admits only an
// installation administrator and forwards them as the object's own paths.
// Object paths that are not operator operations (opening a workspace, Host
// inputs, execution observation) are internal: only another owner holding the
// binding reaches them, the entry Worker never forwards them.
import { isWorkspaceId } from "@opencraft/sandbox/uri";

/** Public operator paths: `/__opencraft_workspaces/<workspace id>/<operation>`. */
export const WORKSPACE_HOST_PREFIX = "/__opencraft_workspaces/";
/** The object's own paths. */
export const WORKSPACE_HOST_OBJECT_PREFIX = "/__workspace_host/";
/** Names the workspace a request to the object is for; the object refuses any other. */
export const WORKSPACE_HOST_HEADER = "x-opencraft-workspace";

/** Operator operations and their methods (Node: `workspace-admin.mjs open|sleep|discard`). */
export const WORKSPACE_HOST_OPERATIONS = Object.freeze({ status: "GET", wake: "POST", sleep: "POST" } as const);
export type WorkspaceHostOperation = keyof typeof WORKSPACE_HOST_OPERATIONS;

/** Owner-to-owner operations; never forwarded from the public entry. */
export const WORKSPACE_HOST_INTERNAL_OPERATIONS = Object.freeze({
  open: "POST",
  inputs: "POST",
  execution: "GET",
} as const);
export type WorkspaceHostInternalOperation = keyof typeof WORKSPACE_HOST_INTERNAL_OPERATIONS;

/** The public operator route a path names, or null. A malformed workspace id names none. */
export function workspaceHostRoute(
  pathname: string,
): { readonly workspace: string; readonly operation: WorkspaceHostOperation } | null {
  if (!pathname.startsWith(WORKSPACE_HOST_PREFIX)) return null;
  const [workspace, operation, ...rest] = pathname.slice(WORKSPACE_HOST_PREFIX.length).split("/");
  if (rest.length || !isWorkspaceId(workspace) || !Object.hasOwn(WORKSPACE_HOST_OPERATIONS, operation ?? ""))
    return null;
  return { workspace: workspace!, operation: operation as WorkspaceHostOperation };
}

/** The object operation a path names (public or internal), or null. */
export function workspaceHostObjectOperation(
  pathname: string,
): WorkspaceHostOperation | WorkspaceHostInternalOperation | null {
  if (!pathname.startsWith(WORKSPACE_HOST_OBJECT_PREFIX)) return null;
  const operation = pathname.slice(WORKSPACE_HOST_OBJECT_PREFIX.length);
  return Object.hasOwn(WORKSPACE_HOST_OPERATIONS, operation) ||
    Object.hasOwn(WORKSPACE_HOST_INTERNAL_OPERATIONS, operation)
    ? (operation as WorkspaceHostOperation | WorkspaceHostInternalOperation)
    : null;
}

/** The method an object operation accepts. */
export function workspaceHostMethod(operation: WorkspaceHostOperation | WorkspaceHostInternalOperation): string {
  return Object.hasOwn(WORKSPACE_HOST_OPERATIONS, operation)
    ? WORKSPACE_HOST_OPERATIONS[operation as WorkspaceHostOperation]
    : WORKSPACE_HOST_INTERNAL_OPERATIONS[operation as WorkspaceHostInternalOperation];
}

/** The object name a workspace is addressed by (`idFromName`); one object per workspace id. */
export function workspaceHostObjectName(workspace: string): string {
  if (!isWorkspaceId(workspace)) throw new Error("Invalid workspace id");
  return `workspace:${workspace}`;
}
