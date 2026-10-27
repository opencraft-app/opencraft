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
  less: "css",
  sass: "css",
  scss: "css",
  go: "go",
  h: "cpp",
  hpp: "cpp",
  html: "html",
  htm: "html",
  java: "java",
  js: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  json: "json",
  jsx: "jsx",
  md: "markdown",
  markdown: "markdown",
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
  if (/^[\\/]+$/u.test(path)) return "/";
  if (/^[a-z]:[\\/]+$/iu.test(path)) return `${path.slice(0, 2)}/`;
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

export type WorkspaceFileKind = "css" | "javascript" | "typescript" | "json" | "image" | "text" | "code";

export interface WorkspaceDraft {
  readonly baseText: string;
  readonly text: string;
}

export interface WorkspaceSaveTarget {
  readonly hostId: string;
  readonly path: string;
  readonly key: string;
  readonly text: string;
}

export async function writeWorkspaceResource(
  previewOnly: boolean,
  target: WorkspaceSaveTarget,
  writeFile: (path: string, contentBase64: string) => Promise<unknown>,
  invalidate: (hostId: string, path: string) => Promise<unknown>,
): Promise<void> {
  if (previewOnly) throw new Error("This panel is read-only");
  await writeFile(target.path, encodeBase64Text(target.text));
  await invalidate(target.hostId, target.path);
}

export function workspaceDraftKey(hostId: string, path: string): string {
  return `${hostId}\u0000${path}`;
}

export function updateWorkspaceDraft(
  drafts: Readonly<Record<string, WorkspaceDraft>>,
  key: string,
  serverText: string,
  text: string,
): Record<string, WorkspaceDraft> {
  const baseText = drafts[key]?.baseText ?? serverText;
  const next = { ...drafts };
  if (text === baseText) delete next[key];
  else next[key] = { baseText, text };
  return next;
}

export function reconcileWorkspaceSave(
  drafts: Readonly<Record<string, WorkspaceDraft>>,
  key: string,
  submittedText: string,
): Record<string, WorkspaceDraft> {
  const existing = drafts[key];
  if (existing === undefined) return { ...drafts };
  const next = { ...drafts };
  if (existing.text === submittedText) delete next[key];
  else next[key] = { baseText: submittedText, text: existing.text };
  return next;
}

export function workspaceDraftConflicted(draft: WorkspaceDraft | undefined, serverText: string | null): boolean {
  return draft !== undefined && serverText !== null && draft.baseText !== serverText;
}

export function workspaceFileKind(path: string): WorkspaceFileKind {
  if (workspaceImageMime(path) !== null) return "image";
  const language = workspaceFileLanguage(path);
  if (language === "css") return "css";
  if (language === "javascript" || language === "jsx") return "javascript";
  if (language === "typescript" || language === "tsx") return "typescript";
  if (language === "json") return "json";
  if (language === "markdown") return "text";
  return language === null ? "text" : "code";
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
  const roots = [...new Set(configuredRoots.map((root) => {
    if (/^[\\/]+$/u.test(root)) return "/";
    if (/^[a-z]:[\\/]+$/iu.test(root)) return `${root.slice(0, 2)}/`;
    return root.replaceAll("\\", "/").replace(/\/+$/u, "");
  }))]
    .filter(Boolean);
  if (roots.length > 0) return roots;
  if (cwd !== null && cwd.length > 0) return [cwd];
  return [workspacePathParent(normalizedPath)];
}
