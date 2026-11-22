import { createHash } from "node:crypto";

/** Internal catalog resolution, not a renderer payload or an authorization grant.
 * Contains immutable identities only; credentials and provider URLs stay in the
 * current authorized configuration resolver. Paths are derived by that resolver. */
export interface ResolvedWorkspaceSelection {
  version: 1;
  environment: {
    configurationId: string;
    configurationRevision: string;
    templateId: string;
    cpuMillis: number;
    memoryBytes: number;
  };
  source:
    | { kind: "empty" }
    | {
        kind: "git";
        repositoryId: string;
        commit: string;
        libraryId: string;
        authorizationDomain: string;
        generation: string;
        relativePath: string;
      }
    | {
        kind: "library-reference";
        libraryId: string;
        authorizationDomain: string;
        generation: string;
        relativePath: string;
      };
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).length === names.length && names.every((n) => Object.hasOwn(v, n));
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/u.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const path = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 2048 &&
  (v === "" || (!/[\\\x00-\x1f\x7f:%]/u.test(v) && v.split("/").every((p) => p.length > 0 && p !== "." && p !== "..")));
export function encodeWorkspaceSelection(input: unknown): {
  value: ResolvedWorkspaceSelection;
  json: string;
  digest: string;
} {
  const fail = (): never => {
    throw Error("Invalid resolved workspace selection");
  };
  if (!object(input) || !keys(input, ["version", "environment", "source"]) || input.version !== 1) return fail();
  const e = input.environment,
    s = input.source;
  if (
    !object(e) ||
    !keys(e, ["configurationId", "configurationRevision", "templateId", "cpuMillis", "memoryBytes"]) ||
    !id(e.configurationId) ||
    typeof e.configurationRevision !== "string" ||
    !/^[a-f0-9]{64}$/.test(e.configurationRevision) ||
    !id(e.templateId) ||
    !positive(e.cpuMillis) ||
    !positive(e.memoryBytes) ||
    !object(s)
  )
    return fail();
  let source: ResolvedWorkspaceSelection["source"];
  if (s.kind === "empty" && keys(s, ["kind"])) source = { kind: "empty" };
  else {
    const common = ["kind", "libraryId", "authorizationDomain", "generation", "relativePath"];
    if (!id(s.libraryId) || !id(s.authorizationDomain) || !id(s.generation) || !path(s.relativePath)) return fail();
    const base = {
      libraryId: s.libraryId,
      authorizationDomain: s.authorizationDomain,
      generation: s.generation,
      relativePath: s.relativePath,
    };
    if (
      s.kind === "git" &&
      keys(s, [...common, "repositoryId", "commit"]) &&
      id(s.repositoryId) &&
      typeof s.commit === "string" &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s.commit)
    )
      source = { kind: "git", repositoryId: s.repositoryId, commit: s.commit, ...base };
    else if (s.kind === "library-reference" && keys(s, common)) source = { kind: "library-reference", ...base };
    else return fail();
  }
  const value: ResolvedWorkspaceSelection = {
    version: 1,
    environment: {
      configurationId: e.configurationId,
      configurationRevision: e.configurationRevision,
      templateId: e.templateId,
      cpuMillis: e.cpuMillis,
      memoryBytes: e.memoryBytes,
    },
    source,
  };
  const json = JSON.stringify(value);
  return { value, json, digest: createHash("sha256").update(json).digest("hex") };
}

/** Private working directory is derived from the durable source selection, never
 * from a renderer path or a preparation receipt. Library references remain data
 * inputs; only a private Git checkout changes the conversation's working cwd. */
export function ordinaryWorkspaceCwd(input: ResolvedWorkspaceSelection): string {
  const { source } = encodeWorkspaceSelection(input).value;
  return source.kind === "git"
    ? "/workspace/project" + (source.relativePath ? "/" + source.relativePath : "")
    : "/workspace";
}
