import type { BlobResourceService } from "@opencraft/blob-resources";
import type { QueryClient } from "@tanstack/react-query";
import { workspaceLocationResource } from "../panels/workspace-sessions";

export function embeddedWorkspaceResource(path: string): string | null {
  if (!/^(?:\/(?![\\/])|[a-z]:[\\/])/iu.test(path) || /[\u0000-\u001f\u007f]/u.test(path)) return null;
  const normalized = path.replaceAll("\\", "/");
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) return null;
  try {
    return workspaceLocationResource({ path: normalized, line: null, column: null });
  } catch {
    return null;
  }
}

export type WorkspaceQueryOwner = readonly [ownerId: string, hostReadScope: string];

export function workspaceFileQueryKey(
  kind: "resource" | "directory",
  hostId: string,
  path: string,
  readScope: string,
  [ownerId, hostReadScope]: WorkspaceQueryOwner,
) {
  return ["appserver-fs", hostId, kind, path, readScope, ownerId, hostReadScope] as const;
}

/** Reuse the panel's query and Blob caches, including the scoped workspace-file runtime. */
export async function refreshEmbeddedWorkspaceFiles(
  queryClient: QueryClient,
  blobs: Pick<BlobResourceService, "refresh">,
  hostId: string,
  [ownerId, hostReadScope]: WorkspaceQueryOwner,
  isCurrent: () => boolean,
): Promise<void> {
  const queries = queryClient.getQueryCache().findAll({
    predicate: ({ queryKey: key }) =>
      key[0] === "appserver-fs" &&
      key[1] === hostId &&
      (key[2] === "resource" || key[2] === "directory") &&
      key[5] === ownerId &&
      key[6] === hostReadScope,
  });
  if (!isCurrent() || queries.length === 0) return;

  const matches = new Set(queries);
  const filter = { predicate: (query: (typeof queries)[number]) => matches.has(query) };
  await queryClient.cancelQueries(filter);
  if (!isCurrent()) return;

  const files = new Map<string, { path: string; scope: string }>();
  for (const {
    queryKey: [, , kind, path, scope],
  } of queries) {
    if (kind === "resource" && typeof path === "string" && typeof scope === "string") {
      files.set(JSON.stringify([scope, path]), { scope, path });
    }
  }
  await Promise.all(Array.from(files.values(), (resource) => blobs.refresh(resource)));
  if (isCurrent()) await queryClient.invalidateQueries(filter);
}
