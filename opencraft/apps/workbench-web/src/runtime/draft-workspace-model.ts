import { AppServerRpcError } from "@opencraft/appserver-client";
import type { Project, ProjectCreateParams } from "@opencraft/appserver-protocol/generated/v2";

export interface DraftWorkspaceOption {
  readonly cwd: string;
  readonly runtimeWorkspaceRoots: readonly string[];
  readonly label: string;
  readonly rootLabel: string;
  readonly projectId: string;
  readonly branch?: string | null;
}

export function buildDraftWorkspaceOptions(
  projects: readonly Project[],
): readonly DraftWorkspaceOption[] {
  const seen = new Set<string>();
  return projects.flatMap((project) => {
    const roots = project.roots.map((root) => root.path);
    const branch = project.metadata.branch ?? project.metadata.gitBranch ?? null;
    return roots.flatMap((cwd) => {
      const key = `${project.id}:${cwd}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const segment = cwd.split(/[\\/]+/u).filter(Boolean).at(-1) ?? cwd;
      return [{
        cwd,
        runtimeWorkspaceRoots: roots,
        label: project.name
          ?? `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`,
        rootLabel: segment,
        projectId: project.id,
        branch,
      }];
    });
  });
}

function subsequenceScore(value: string, query: string): number | null {
  let cursor = 0;
  let first = -1;
  let last = -1;
  for (const character of query) {
    const index = value.indexOf(character, cursor);
    if (index < 0) return null;
    if (first < 0) first = index;
    last = index;
    cursor = index + 1;
  }
  return 300 + first + Math.max(0, last - first - query.length + 1);
}

function scoreCandidate(rawValue: string, rawQuery: string): number | null {
  const value = rawValue.toLocaleLowerCase();
  const query = rawQuery.toLocaleLowerCase();
  if (value === query) return 0;
  if (value.startsWith(query)) return 10 + value.length - query.length;
  const substring = value.indexOf(query);
  if (substring >= 0) return 100 + substring;
  return subsequenceScore(value, query);
}

/** Stable Codex-shaped fuzzy ordering for the Project picker. */
export function searchDraftWorkspaceOptions(
  options: readonly DraftWorkspaceOption[],
  rawQuery: string,
): readonly DraftWorkspaceOption[] {
  const query = rawQuery.trim();
  if (query.length === 0) return options;
  return options
    .map((option, index) => ({
      option,
      index,
      score: Math.min(
        scoreCandidate(option.label, query) ?? Number.POSITIVE_INFINITY,
        scoreCandidate(option.rootLabel, query) ?? Number.POSITIVE_INFINITY,
        scoreCandidate(option.cwd, query) ?? Number.POSITIVE_INFINITY,
      ),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => left.score - right.score
      || left.option.label.localeCompare(right.option.label)
      || left.option.cwd.localeCompare(right.option.cwd)
      || left.index - right.index)
    .map((entry) => entry.option);
}

export function resolveProjectCwd(project: Project, requestedPath: string): string {
  const roots = project.roots.map((root) => root.path);
  const cwd = roots.includes(requestedPath) ? requestedPath : roots[0];
  if (cwd === undefined) throw new Error("The selected project has no workspace root");
  return cwd;
}

/** A selected Server directory need not have a Server-owned Project record. */
export async function resolveDraftDirectorySelection(options: {
  readonly path: string;
  readonly projects: readonly Project[];
  readonly projectCatalogError: Error | null;
  readonly createProject: (params: ProjectCreateParams) => Promise<{ readonly project: Project }>;
}): Promise<{ readonly workspace: { readonly cwd: string; readonly runtimeWorkspaceRoots: readonly string[]; readonly projectId?: string }; readonly createdProject: boolean }> {
  const unsupported = (error: unknown) => error instanceof AppServerRpcError && error.code === -32601;
  const directory = { cwd: options.path, runtimeWorkspaceRoots: [options.path] };
  let project = options.projects.find(candidate => candidate.roots.some(root => root.path === options.path));
  let createdProject = false;
  if (project === undefined) {
    // This is not a fallback to local storage. The selected namespace remains
    // on the same Server and only the current Draft receives a cwd.
    if (unsupported(options.projectCatalogError)) return { workspace: directory, createdProject };
    try {
      const result = await options.createProject({
        name: options.path.split(/[\\/]+/u).filter(Boolean).at(-1) ?? "Project",
        roots: [{ path: options.path }],
        idempotencyKey: `opencraft-web:add-project:${options.path}`,
        metadata: { origin: "opencraft-web-directory-picker" },
      });
      project = result.project;
      createdProject = true;
    } catch (error) {
      // Authentication/network/unknown mutation outcomes must not turn into
      // apparent success. Only an explicit missing method permits cwd-only.
      if (!unsupported(error)) throw error;
      return { workspace: directory, createdProject };
    }
  }
  return { workspace: { cwd: resolveProjectCwd(project, options.path),
    runtimeWorkspaceRoots: project.roots.map(root => root.path), projectId: project.id }, createdProject };
}
