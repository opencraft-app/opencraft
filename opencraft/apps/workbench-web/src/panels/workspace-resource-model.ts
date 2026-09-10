export const MAX_EDITABLE_FILE_BYTES = 4 * 1024 * 1024;

export interface WorkspaceResourceLocation {
  readonly path: string;
  readonly line: number | null;
  readonly column: number | null;
}

const imageMimeByExtension: Readonly<Record<string, string>> = Object.freeze({
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
});

const languageByExtension: Readonly<Record<string, string>> = Object.freeze({
  bash: "bash",
  c: "cpp",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  go: "go",
  h: "cpp",
  hpp: "cpp",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  md: "markdown",
  py: "python",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  swift: "swift",
  ts: "typescript",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yaml",
});

function extension(path: string): string {
  return /\.([a-z0-9]+)$/iu.exec(path)?.[1]?.toLowerCase() ?? "";
}

export function parseWorkspaceResource(resource: string): WorkspaceResourceLocation {
  const hash = /#L(\d+)(?:C(\d+))?/u.exec(resource);
  const withoutFragment = resource.replace(/#.*$/u, "");
  let path = withoutFragment;
  if (/^file:/iu.test(withoutFragment)) {
    const url = new URL(withoutFragment);
    path = decodeURIComponent(url.pathname);
    if (/^\/[a-z]:\//iu.test(path)) path = path.slice(1);
  }
  return {
    path: path.replaceAll("\\", "/"),
    line: hash === null ? null : Number(hash[1]),
    column: hash?.[2] === undefined ? null : Number(hash[2]),
  };
}

export function workspacePathParent(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) return normalized.startsWith("/") ? "/" : normalized;
  return normalized.slice(0, slash);
}

export function joinWorkspacePath(parent: string, child: string): string {
  return `${parent.replace(/[\\/]+$/u, "")}/${child.replace(/^[\\/]+/u, "")}`;
}

export function workspaceResourceBasename(path: string): string {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;
}

export function workspaceFileLanguage(path: string): string | null {
  return languageByExtension[extension(path)] ?? null;
}

export function workspaceImageMime(path: string): string | null {
  return imageMimeByExtension[extension(path)] ?? null;
}

export function decodeBase64Bytes(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeBase64Text(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function decodeWorkspaceText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function workspaceRootsForResource(
  configuredRoots: readonly string[],
  cwd: string | null,
  path: string,
): readonly string[] {
  const normalizedPath = path.replaceAll("\\", "/");
  const roots = [...new Set(configuredRoots.map((root) => root.replaceAll("\\", "/").replace(/\/+$/u, "")))]
    .filter(Boolean);
  if (roots.length > 0) return roots;
  if (cwd !== null && cwd.length > 0) return [cwd];
  return [workspacePathParent(normalizedPath)];
}

