export function normalizeWorkspacePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

export function isWorkspacePathWithinRoot(path: string, rootPath: string): boolean {
  const pathValue = normalizeWorkspacePath(path);
  const rootValue = normalizeWorkspacePath(rootPath);
  if (rootValue === "/") return pathValue.startsWith("/");
  return pathValue === rootValue || pathValue.startsWith(`${rootValue}/`);
}

export function joinWorkspacePath(parent: string, child: string): string {
  return normalizeWorkspacePath(`${parent}/${child}`);
}

export function workspaceParentPath(path: string, rootPath: string): string {
  const pathValue = normalizeWorkspacePath(path);
  const rootValue = normalizeWorkspacePath(rootPath);
  if (pathValue === rootValue) return rootValue;
  const parent = pathValue.slice(0, pathValue.lastIndexOf("/")) || "/";
  return isWorkspacePathWithinRoot(parent, rootValue) ? parent : rootValue;
}

export function resolveWorkspacePickerInitialPath(
  initialPath: string | null | undefined,
  rootPath: string,
): string {
  if (initialPath !== null
    && initialPath !== undefined
    && isWorkspacePathWithinRoot(initialPath, rootPath)) {
    return normalizeWorkspacePath(initialPath);
  }
  return normalizeWorkspacePath(rootPath);
}
