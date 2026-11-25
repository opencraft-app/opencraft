import type { Project, ProjectCreateParams, ProjectListParams } from "@opencraft/appserver-protocol/generated/v2";
import { isWorkspaceFilePath, isWorkspaceFileResult } from "./workspace-files.js";

export const WORKSPACE_PROJECT_METHODS = ["project/list", "project/create"] as const;
type ProjectMethod = (typeof WORKSPACE_PROJECT_METHODS)[number];
type DirectoryMethod = "fs/readDirectory" | "fs/getMetadata";
type WorkspaceProjectCall =
  | { method: "project/create"; params: ProjectCreateParams }
  | { method: "project/list"; params: ProjectListParams }
  | { method: DirectoryMethod; params: { path: string } };

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const projectRoots = (value: unknown): value is Project["roots"] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 16 &&
  value.every((root) => !!object(root) && keys(root, ["path"]) && isWorkspaceFilePath(root.path)) &&
  new Set(value.map((root) => root.path)).size === value.length;
const metadata = (value: unknown): value is Record<string, string> =>
  !!object(value) &&
  Object.keys(value as object).length <= 24 &&
  Object.entries(value as object).every(
    ([key, item]) => bounded(key, 128) && typeof item === "string" && item.length <= 1024,
  );

export function isWorkspaceProjectMethod(method: string, value: unknown): method is ProjectMethod | DirectoryMethod {
  return (
    method === "project/list" ||
    method === "project/create" ||
    ((method === "fs/readDirectory" || method === "fs/getMetadata") && object(value)?.workspaceThreadId === undefined)
  );
}

export function parseWorkspaceProjectCall(method: unknown, raw: unknown): WorkspaceProjectCall | null {
  const params = object(raw === undefined && method === "project/list" ? {} : raw);
  if (!params || typeof method !== "string" || !isWorkspaceProjectMethod(method, params)) return null;
  if (method === "project/list") {
    const { cursor, limit, sortKey, sortDirection } = params;
    if (
      !keys(params, ["cursor", "limit", "sortKey", "sortDirection"]) ||
      (cursor != null && !bounded(cursor, 512)) ||
      (limit != null && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)) ||
      (sortKey != null && sortKey !== "position" && sortKey !== "recencyAt") ||
      (sortDirection != null && ((sortDirection !== "asc" && sortDirection !== "desc") || sortKey == null))
    )
      return null;
    return {
      method,
      params: {
        cursor: cursor ?? null,
        limit: limit ?? 100,
        ...(sortKey == null ? {} : { sortKey }),
        ...(sortDirection == null ? {} : { sortDirection }),
      },
    };
  }
  if (method === "project/create") {
    const { name, roots, idempotencyKey, metadata: details } = params;
    if (
      !keys(params, ["name", "roots", "idempotencyKey", "metadata"]) ||
      !bounded(name, 256) ||
      !name.trim() ||
      !bounded(idempotencyKey, 4096) ||
      !projectRoots(roots) ||
      (details != null && !metadata(details)) ||
      new TextEncoder().encode(JSON.stringify(params)).byteLength > 24 * 1024
    )
      return null;
    return { method, params: { name, roots, idempotencyKey, ...(details == null ? {} : { metadata: details }) } };
  }
  return keys(params, ["path"]) && isWorkspaceFilePath(params.path) ? { method, params: { path: params.path } } : null;
}

function isWorkspaceProject(value: unknown): value is Project {
  const project = object(value);
  return (
    !!project &&
    bounded(project.id, 512) &&
    bounded(project.name, 256) &&
    projectRoots(project.roots) &&
    metadata(project.metadata) &&
    [project.position, project.createdAt, project.updatedAt].every(Number.isFinite) &&
    (project.recencyAt === null || Number.isFinite(project.recencyAt))
  );
}

export function workspaceProjectPage(value: unknown) {
  const page = object(value);
  if (
    !page ||
    !Array.isArray(page.data) ||
    page.data.length > 100 ||
    !page.data.every(isWorkspaceProject) ||
    (page.nextCursor !== null && !bounded(page.nextCursor, 512))
  )
    return null;
  return { data: page.data as Project[], nextCursor: page.nextCursor };
}

export function isWorkspaceProjectResult(method: WorkspaceProjectCall["method"], value: unknown): boolean {
  if (method === "project/list") return workspaceProjectPage(value) !== null;
  if (method === "project/create") return isWorkspaceProject(object(value)?.project);
  return isWorkspaceFileResult(method, value);
}

export interface WorkspaceProjectAssignment {
  readonly projectId: string;
  readonly cwd: string;
  readonly runtimeWorkspaceRoots: readonly string[];
}

export function parseWorkspaceProjectAssignment(value: Record<string, unknown>): WorkspaceProjectAssignment | null {
  const { projectId, cwd, runtimeWorkspaceRoots } = value;
  if (
    !bounded(projectId, 512) ||
    !isWorkspaceFilePath(cwd) ||
    !Array.isArray(runtimeWorkspaceRoots) ||
    runtimeWorkspaceRoots.length < 1 ||
    runtimeWorkspaceRoots.length > 16 ||
    !runtimeWorkspaceRoots.every(isWorkspaceFilePath) ||
    new Set(runtimeWorkspaceRoots).size !== runtimeWorkspaceRoots.length ||
    !runtimeWorkspaceRoots.includes(cwd)
  )
    return null;
  return { projectId, cwd, runtimeWorkspaceRoots };
}

export function projectMatchesAssignment(project: Project, assignment: WorkspaceProjectAssignment): boolean {
  const roots = project.roots.map((root) => root.path);
  return (
    project.id === assignment.projectId &&
    roots.includes(assignment.cwd) &&
    roots.length === assignment.runtimeWorkspaceRoots.length &&
    assignment.runtimeWorkspaceRoots.every((root) => roots.includes(root))
  );
}
