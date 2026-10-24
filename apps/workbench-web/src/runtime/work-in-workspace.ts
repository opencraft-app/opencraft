import type { ComposerExecutionTarget } from "@opencraft/composer-core";
import type { AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";

type Workspace = ComposerExecutionTarget["workspace"];
const emptyWorkspace: Workspace = { cwd: null, runtimeWorkspaceRoots: [] };
function unsupported(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === -32601;
}

/** Filesystem existence owns preservation; catalogs only supply a Host-owned project ID. */
export async function resolveWorkInWorkspace(workspace: Workspace, resources: Pick<AppServerWorkbenchRuntime["resources"], "fileSystem" | "projects">,
  isCurrent: () => boolean): Promise<Workspace | null> {
  if (!isCurrent()) return null;
  const cwd = workspace.cwd;
  if (cwd === null) return emptyWorkspace;
  const roots = [...new Set([cwd, ...workspace.runtimeWorkspaceRoots])];
  try {
    const metadata = await Promise.all(roots.map(path => resources.fileSystem.getMetadata(path)));
    if (!isCurrent()) return null;
    if (metadata.some(entry => !entry.isDirectory)) return emptyWorkspace;
  } catch { return isCurrent() ? emptyWorkspace : null; }
  const folder: Workspace = { cwd, runtimeWorkspaceRoots: roots };
  try {
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const page = await resources.projects.list({ cursor, limit: 100 });
      if (!isCurrent()) return null;
      const project = page.data.find(project => roots.every(path => project.roots.some(root => root.path === path)));
      if (project) return { ...folder, projectId: project.id };
      cursor = page.nextCursor ?? null;
      if (cursor !== null && cursors.has(cursor)) throw new Error("Repeated project cursor");
      if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null);
    return isCurrent() ? folder : null;
  } catch (error) {
    if (!isCurrent()) return null;
    if (unsupported(error)) return folder;
    throw error;
  }
}
