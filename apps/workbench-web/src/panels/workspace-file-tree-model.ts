import type { FsReadDirectoryEntry, FsReadDirectoryResponse } from "@opencraft/appserver-protocol/generated/v2";
import { joinWorkspacePath, workspaceResourceBasename } from "./workspace-resource-model";

export const WORKSPACE_TREE_ROW_HEIGHT = 25;
const fileNameCollator = new Intl.Collator(undefined, { numeric: true });

/** Query select: sorting belongs to a directory data revision, never a render. */
export function selectWorkspaceDirectoryEntries(data: FsReadDirectoryResponse): readonly FsReadDirectoryEntry[] {
  return [...data.entries].sort((left, right) => left.isDirectory === right.isDirectory
    ? fileNameCollator.compare(left.fileName, right.fileName)
    : left.isDirectory ? -1 : 1);
}

export interface WorkspaceTreeDirectory {
  readonly path: string;
  readonly entries: readonly FsReadDirectoryEntry[] | undefined;
  readonly failed: boolean;
}

export type WorkspaceTreeRow = {
  readonly kind: "directory" | "file";
  readonly path: string;
  readonly title: string;
  readonly depth: number;
  readonly parent: string | null;
} | {
  readonly kind: "loading" | "error";
  readonly path: string;
  readonly depth: number;
  readonly parent: string;
};

export function workspaceTreeAncestors(roots: readonly string[], selectedPath: string): readonly string[] {
  const paths = new Set(roots);
  for (const root of roots) {
    if (!selectedPath.startsWith(`${root.replace(/\/$/u, "")}/`)) continue;
    let path = root.replace(/\/$/u, "");
    const parts = selectedPath.slice(path.length + 1).split("/");
    for (const part of parts.slice(0, -1)) {
      path = joinWorkspacePath(path, part);
      paths.add(path);
    }
  }
  return [...paths];
}

/** Collapsed ancestors retain child expansion state, but no child query is observed. */
export function workspaceTreeQueryPaths(roots: readonly string[], expanded: ReadonlySet<string>): readonly string[] {
  return [...expanded].filter(path => roots.some(root => {
    if (path === root) return true;
    const prefix = `${root.replace(/\/$/u, "")}/`;
    if (!path.startsWith(prefix) || !expanded.has(root)) return false;
    let ancestor = root.replace(/\/$/u, "");
    for (const part of path.slice(prefix.length).split("/").slice(0, -1)) {
      ancestor = joinWorkspacePath(ancestor, part);
      if (!expanded.has(ancestor)) return false;
    }
    return true;
  }));
}

export function projectWorkspaceTree(
  roots: readonly string[],
  expanded: ReadonlySet<string>,
  directories: readonly WorkspaceTreeDirectory[],
): readonly WorkspaceTreeRow[] {
  const byPath = new Map(directories.map(directory => [directory.path, directory]));
  const pending: WorkspaceTreeRow[] = roots.map(path => ({
    kind: "directory" as const, path, title: workspaceResourceBasename(path), depth: 0, parent: null,
  })).reverse();
  const rows: WorkspaceTreeRow[] = [];
  while (pending.length > 0) {
    const row = pending.pop()!;
    rows.push(row);
    if (row.kind !== "directory" || !expanded.has(row.path)) continue;
    const directory = byPath.get(row.path);
    if (directory?.entries === undefined) {
      pending.push({ kind: directory?.failed ? "error" : "loading", path: `${row.path}\u0000status`, depth: row.depth + 1, parent: row.path });
      continue;
    }
    for (let index = directory.entries.length - 1; index >= 0; index -= 1) {
      const entry = directory.entries[index]!;
      pending.push({ kind: entry.isDirectory ? "directory" : "file", path: joinWorkspacePath(row.path, entry.fileName), title: entry.fileName, depth: row.depth + 1, parent: row.path });
    }
  }
  return rows;
}

export function workspaceTreeWindow(count: number, scrollTop: number, viewportHeight: number) {
  const height = Math.max(WORKSPACE_TREE_ROW_HEIGHT, viewportHeight);
  const top = Math.max(0, Math.min(scrollTop, count * WORKSPACE_TREE_ROW_HEIGHT - height));
  const start = Math.max(0, Math.floor(top / WORKSPACE_TREE_ROW_HEIGHT) - 8);
  const end = Math.min(count, Math.ceil((top + height) / WORKSPACE_TREE_ROW_HEIGHT) + 8);
  return { start, end, height: count * WORKSPACE_TREE_ROW_HEIGHT };
}
