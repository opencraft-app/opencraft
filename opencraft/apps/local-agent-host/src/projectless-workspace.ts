import { mkdir, realpath, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";

export type LocalWorkspaceKind = "project" | "projectless";

export interface LocalWorkspaceResolution {
  readonly cwd: string;
  readonly runtimeWorkspaceRoots: readonly string[];
  readonly kind: LocalWorkspaceKind;
  rollback(): Promise<void>;
}

export interface LocalWorkspaceResolutionInput {
  readonly cwd?: unknown;
  readonly runtimeWorkspaceRoots?: unknown;
}

export class LocalWorkspaceResolutionError extends Error {
  readonly rpcCode = -32064;
  readonly domainData: { readonly code: string };

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalWorkspaceResolutionError";
    this.domainData = Object.freeze({ code });
  }
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new LocalWorkspaceResolutionError(
      "WORKSPACE_PATH_INVALID",
      "Workspace paths must be absolute on the selected Host.",
    );
  }
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) {
      throw new LocalWorkspaceResolutionError(
        "WORKSPACE_NOT_DIRECTORY",
        "The selected workspace is not a directory on this Host.",
      );
    }
    return canonical;
  } catch (error) {
    if (error instanceof LocalWorkspaceResolutionError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new LocalWorkspaceResolutionError(
        "WORKSPACE_NOT_FOUND",
        "The selected workspace does not exist on this Host.",
        { cause: error },
      );
    }
    throw new LocalWorkspaceResolutionError(
      "WORKSPACE_UNAVAILABLE",
      "The selected workspace is unavailable on this Host.",
      { cause: error },
    );
  }
}

/** Host-owned workspace resolution. The Renderer never guesses a user's home path. */
export class LocalWorkspaceResolver {
  private readonly projectlessRoot: string;

  constructor(options: {
    readonly projectlessRoot?: string;
    readonly createId?: () => string;
  } = {}) {
    this.projectlessRoot = options.projectlessRoot ?? join(homedir(), "OpenCraft");
    this.createId = options.createId ?? randomUUID;
  }

  private readonly createId: () => string;

  async resolve(input: LocalWorkspaceResolutionInput): Promise<LocalWorkspaceResolution> {
    const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
    if (cwd !== "") return this.resolveProject(cwd, input.runtimeWorkspaceRoots);
    return this.createProjectless();
  }

  private async resolveProject(
    cwd: string,
    rawRoots: unknown,
  ): Promise<LocalWorkspaceResolution> {
    const canonicalCwd = await canonicalDirectory(cwd);
    const requestedRoots = Array.isArray(rawRoots)
      ? rawRoots.filter((root): root is string => typeof root === "string" && root.trim() !== "")
      : [];
    const roots: string[] = [];
    for (const root of requestedRoots.length === 0 ? [cwd] : requestedRoots) {
      const canonical = root === cwd ? canonicalCwd : await canonicalDirectory(root.trim());
      if (!roots.includes(canonical)) roots.push(canonical);
    }
    if (!roots.some((root) => isWithin(root, canonicalCwd))) roots.unshift(canonicalCwd);
    return Object.freeze({
      cwd: canonicalCwd,
      runtimeWorkspaceRoots: Object.freeze(roots),
      kind: "project" as const,
      rollback: async () => undefined,
    });
  }

  private async createProjectless(): Promise<LocalWorkspaceResolution> {
    try {
      await mkdir(this.projectlessRoot, { recursive: true, mode: 0o700 });
      const root = await canonicalDirectory(this.projectlessRoot);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const id = this.createId();
        if (!/^[A-Za-z0-9._-]{1,128}$/u.test(id)) {
          throw new LocalWorkspaceResolutionError(
            "WORKSPACE_ID_INVALID",
            "OpenCraft generated an invalid projectless workspace identity.",
          );
        }
        const directory = join(root, `thread-${id}`);
        try {
          await mkdir(directory, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
        let retained = false;
        return Object.freeze({
          cwd: directory,
          runtimeWorkspaceRoots: Object.freeze([directory]),
          kind: "projectless" as const,
          rollback: async () => {
            if (retained) return;
            retained = true;
            try { await rmdir(directory); }
            catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
            }
          },
        });
      }
      throw new Error("Projectless workspace identity collision");
    } catch (error) {
      if (error instanceof LocalWorkspaceResolutionError) throw error;
      throw new LocalWorkspaceResolutionError(
        "PROJECTLESS_WORKSPACE_CREATE_FAILED",
        "OpenCraft could not create a projectless workspace on this Host.",
        { cause: error },
      );
    }
  }
}
