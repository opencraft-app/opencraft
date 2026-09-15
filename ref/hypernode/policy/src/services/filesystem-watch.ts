export interface FilesystemWatchResolver {
  owns(path: string): boolean;
  normalize(path: string): string;
}

export interface ResolvedFilesystemWatch {
  path: string;
  routable: boolean;
  error?: unknown;
  drain?(): string[];
  stop?(): void;
}

function normalizeAbsolutePath(path: string): string {
  if (!path.startsWith("/")) throw new Error("filesystem watch paths must be absolute");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error("filesystem watch path escapes the root");
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}

export function resolveFilesystemWatch(
  path: string,
  resolvers: FilesystemWatchResolver[],
  fallback: (path: string) => string,
): ResolvedFilesystemWatch {
  const requestedPath = normalizeAbsolutePath(path);
  for (const resolver of resolvers) {
    if (resolver.owns(requestedPath)) {
      return { path: resolver.normalize(requestedPath), routable: true };
    }
  }
  try {
    return { path: fallback(requestedPath), routable: true };
  } catch (error) {
    return { path: requestedPath, routable: false, error };
  }
}
