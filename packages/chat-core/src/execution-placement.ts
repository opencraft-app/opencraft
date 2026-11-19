/** Logical selection only. None of these fields grants execution/storage access. */
export interface SandboxExecutionTarget {
  readonly version: 1;
  readonly configurationId: string;
  readonly templateId: string;
}
export type WorkspaceSource =
  | {
      readonly version: 1;
      readonly kind: "git";
      readonly repositoryId: string;
      readonly ref: string;
      readonly relativePath: string;
      readonly libraryId?: string;
    }
  | {
      readonly version: 1;
      readonly kind: "library-reference";
      readonly libraryId: string;
      readonly relativePath: string;
    };

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/u.test(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
/** Paths are literal POSIX components, not URLs; never decode again after validation. */
export function isWorkspaceRelativePath(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length <= 2048 &&
    (v === "" ||
      (!/[\\\x00-\x1f\x7f:%]/u.test(v) && v.split("/").every((p) => p.length > 0 && p !== "." && p !== "..")))
  );
}
function gitRef(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= 255 &&
    v !== "@" &&
    !/^[\/-]|[\/.]$|[\x00-\x20\x7f~^:?*\[\\]/u.test(v) &&
    !v.includes("..") &&
    !v.includes("@{") &&
    !v.includes("//") &&
    v.split("/").every((p) => !p.startsWith(".") && !p.endsWith(".lock"))
  );
}
export function isSandboxExecutionTarget(v: unknown): v is SandboxExecutionTarget {
  return (
    record(v) &&
    keys(v, ["version", "configurationId", "templateId"]) &&
    v.version === 1 &&
    id(v.configurationId) &&
    id(v.templateId)
  );
}
export function isWorkspaceSource(v: unknown): v is WorkspaceSource {
  if (!record(v) || v.version !== 1 || !isWorkspaceRelativePath(v.relativePath)) return false;
  if (v.kind === "git")
    return (
      keys(v, ["version", "kind", "repositoryId", "ref", "relativePath", "libraryId"]) &&
      id(v.repositoryId) &&
      gitRef(v.ref) &&
      (v.libraryId === undefined || id(v.libraryId))
    );
  return v.kind === "library-reference" && keys(v, ["version", "kind", "libraryId", "relativePath"]) && id(v.libraryId);
}

export interface WorkspacePlacement {
  readonly version: 1;
  /** Stable submission identity, scoped server-side by authenticated actor/Host. */
  readonly intentId: string;
  readonly environment: SandboxExecutionTarget;
  readonly source?: WorkspaceSource;
}
export function isWorkspacePlacement(v: unknown): v is WorkspacePlacement {
  return (
    record(v) &&
    keys(v, ["version", "intentId", "environment", "source"]) &&
    v.version === 1 &&
    id(v.intentId) &&
    isSandboxExecutionTarget(v.environment) &&
    (v.source === undefined || isWorkspaceSource(v.source))
  );
}
