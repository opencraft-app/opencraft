import type { Project, ProjectListParams } from "@opencraft/appserver-protocol/generated/v2";
import type { WorkspacePlacementRecord } from "@opencraft/sandbox";
import type { StateDocumentStore } from "@opencraft/document-storage/state";
import { workspaceProjectPage } from "./workspace-projects.js";
import {
  directoryCheckpoint,
  matchesDirectoryCheckpoint,
  type WorkspaceDirectoryCheckpoint,
} from "./workspace-directory-checkpoint.js";

const CAPTURE_PAGE_SIZE = 100;
const MAX_CAPTURE_PAGES = 40;
const MAX_CAPTURE_BYTES = 1024 * 1024;
export const PROJECT_DIRECTORY_CURSOR_PREFIX = "oc-project/";

type ProjectCheckpoint = WorkspaceDirectoryCheckpoint & {
  projects: Project[];
};

/** Read the native project directory while the current container is already bound. */
export async function captureWorkspaceProjects(
  read: (page: ProjectListParams) => Promise<unknown>,
): Promise<Project[]> {
  const projects: Project[] = [];
  const projectIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let i = 0; i < MAX_CAPTURE_PAGES; i++) {
    const page = workspaceProjectPage(await read({ cursor, limit: CAPTURE_PAGE_SIZE }));
    if (!page) throw new Error("Invalid project directory page");
    for (const project of page.data) {
      if (projectIds.has(project.id)) throw new Error("Duplicate project in directory");
      projectIds.add(project.id);
      projects.push(project);
    }
    cursor = page.nextCursor;
    if (cursor === null) return projects;
    if (cursors.has(cursor)) throw new Error("Project directory cursor did not advance");
    cursors.add(cursor);
  }
  throw new Error("Project directory exceeds capture budget");
}

export async function recordWorkspaceProjects(
  documents: StateDocumentStore,
  placement: WorkspacePlacementRecord,
  projects: Project[],
) {
  const owner = directoryCheckpoint(placement);
  if (!owner) return;
  const checkpoint: ProjectCheckpoint = { ...owner, projects };
  if (new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength > MAX_CAPTURE_BYTES)
    throw new Error("Project directory exceeds storage budget");
  await documents.update("project-directory", () => ({ result: undefined, next: checkpoint }));
}

export async function readWorkspaceProjects(
  documents: StateDocumentStore,
  placement: WorkspacePlacementRecord | undefined,
  params: ProjectListParams,
) {
  // Keep native cursor and ordering semantics for other views of the directory.
  if (
    (params.sortKey != null && params.sortKey !== "position") ||
    (params.sortDirection != null && params.sortDirection !== "asc")
  )
    return null;
  const value = (await documents.read("project-directory")) as Partial<ProjectCheckpoint> | null;
  if (!matchesDirectoryCheckpoint(value, placement) || !value?.snapshot || !Array.isArray(value.projects)) return null;
  const prefix = `${PROJECT_DIRECTORY_CURSOR_PREFIX}${encodeURIComponent(value.snapshot)}/`;
  const cursorOffset = params.cursor?.startsWith(prefix) ? params.cursor.slice(prefix.length) : "";
  const offset = params.cursor == null ? 0 : /^\d+$/u.test(cursorOffset) ? Number(cursorOffset) : NaN;
  if (!Number.isSafeInteger(offset) || (params.cursor != null && offset >= value.projects.length)) return null;
  const end = offset + (params.limit ?? CAPTURE_PAGE_SIZE);
  return { data: value.projects.slice(offset, end), nextCursor: end < value.projects.length ? prefix + end : null };
}
