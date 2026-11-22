import type { GitGrantScope } from "./personal-git-protocol.js";
export interface GitExecutionLocator {
  readonly hostId: "local-codex" | "opencraft-server";
  readonly threadId: string;
  readonly inputId?: string;
  /** Exact public native Turn alias; the owner derives its immutable input. */
  readonly turnId?: string;
  readonly projectId?: string | null;
}
export interface GitExecutionHandoff {
  readonly scope: GitGrantScope & { readonly projectId: string | null };
  readonly authority: string;
  readonly capability: string;
  readonly native: { readonly turnId: string; readonly incarnation: string };
}
/** Pre-submission configuration only. The broker cannot use this sealed scope
 * until the same pending lease becomes an independently verified live Turn. */
export interface GitExecutionReservation {
  readonly scope: GitExecutionHandoff["scope"];
  readonly authority: string;
  readonly capability: string;
  readonly native: { readonly incarnation: string };
}
export interface GitExecutionResolver {
  /** Trusted compiled owner reads the original immutable lease, not a browser identity. */
  resolve(input: GitExecutionLocator): Omit<GitExecutionHandoff, "authority" | "capability"> | null;
  reserve?(input: GitExecutionLocator): Omit<GitExecutionReservation, "authority" | "capability"> | null;
  close(): void;
}
export function parseGitExecutionLocator(value: unknown): GitExecutionLocator {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("git_execution_unavailable");
  const v = value as Record<string, unknown>;
  const text = (s: unknown) => typeof s === "string" && s.length > 0 && s.length <= 512 && !/[\x00-\x1f\x7f]/u.test(s);
  if (
    Object.keys(v).some((k) => !["hostId", "threadId", "inputId", "turnId", "projectId"].includes(k)) ||
    !["local-codex", "opencraft-server"].includes(String(v.hostId)) ||
    !text(v.threadId) ||
    (v.inputId === undefined) === (v.turnId === undefined) ||
    !text(v.inputId ?? v.turnId) ||
    (v.projectId !== undefined && v.projectId !== null && !text(v.projectId))
  )
    throw Error("git_execution_unavailable");
  return {
    hostId: v.hostId as GitExecutionLocator["hostId"],
    threadId: v.threadId as string,
    ...(v.inputId !== undefined ? { inputId: v.inputId as string } : { turnId: v.turnId as string }),
    projectId: v.projectId as string | null | undefined,
  };
}
