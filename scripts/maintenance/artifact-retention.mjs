import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const DISPOSABLE_MANIFEST = ".opencraft-disposable.json";
const under = (path, root) => path === root || path.startsWith(`${root}${sep}`);

// Check every component: lstat on the leaf alone would follow a symlinked parent.
async function realDirectory(path) {
  for (let part = resolve(path); ; part = resolve(part, "..")) {
    const info = await lstat(part);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    if (part === resolve(part, "..")) return true;
  }
}

async function entries(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function releaseCandidates(root) {
  if (!(await realDirectory(root))) return [];
  const directories = (await entries(root)).filter((entry) => entry.isDirectory());
  const kept = new Set();
  let unknown = false;
  for (const name of ["current", "previous"]) {
    try {
      const pointer = join(root, name);
      if (!(await lstat(pointer)).isSymbolicLink()) throw new Error("not a pointer");
      const target = await realpath(pointer);
      if (!directories.some((entry) => join(root, entry.name) === target)) throw new Error("not a release");
      kept.add(target);
    } catch (error) {
      if (name === "current" || error.code !== "ENOENT") unknown = true;
    }
  }
  // Legacy deployments did not record previous. Keep their most recent other
  // release until the next deployment explicitly records the rollback pointer.
  if (kept.size === 1 && !unknown) {
    const history = await Promise.all(
      directories
        .filter((entry) => !kept.has(join(root, entry.name)))
        .map(async (entry) => ({ path: join(root, entry.name), mtime: (await lstat(join(root, entry.name))).mtimeMs })),
    );
    history.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    if (history[0]) kept.add(history[0].path);
  }
  // Other operator pointers also count as recovery dependencies.
  for (const entry of await entries(root)) {
    if (!entry.isSymbolicLink() || ["current", "previous"].includes(entry.name)) continue;
    try {
      kept.add(await realpath(join(root, entry.name)));
    } catch {
      unknown = true;
    }
  }
  return directories.map((entry) => {
    const path = join(root, entry.name);
    return {
      path,
      kind: "release",
      owner: root,
      keepReason: unknown
        ? "release-pointers-unknown"
        : [...kept].some((target) => under(target, path))
          ? "release-pointer"
          : undefined,
    };
  });
}

async function completedArtifacts(stage) {
  const manifestPath = join(stage, DISPOSABLE_MANIFEST);
  let manifest;
  try {
    if (!(await lstat(manifestPath)).isFile()) throw new Error("Manifest must be a regular file");
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.paths)) throw new Error("Invalid disposable manifest");
  const result = [];
  for (const name of manifest.paths) {
    if (
      typeof name !== "string" ||
      isAbsolute(name) ||
      name.split(/[\\/]/u).some((part) => !part || part === "." || part === ".." || part === ".git")
    )
      throw new Error("Disposable paths must stay below their stage, excluding .git");
    const path = resolve(stage, name);
    if (!under(path, stage) || path === manifestPath) throw new Error("Invalid disposable path");
    try {
      if (!(await realDirectory(resolve(path, "..")))) throw new Error("Symlinked artifact parent");
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isFile() || info.isDirectory()) result.push({ path, kind: "accepted-artifact", owner: stage });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return result;
}

/** Narrow children of a retained owner; never make its workbook/config disposable. */
export async function artifactCandidates(root, report = () => {}) {
  const result = [];
  for (const owner of await entries(root)) {
    if (!owner.isDirectory() || (basename(root) === ".local" && owner.name === "maintenance")) continue;
    const path = join(root, owner.name);
    if (owner.name === "steward" && basename(root) === ".local") {
      for (const stage of await entries(path)) {
        if (!stage.isDirectory()) continue;
        try {
          result.push(...(await completedArtifacts(join(path, stage.name))));
        } catch (error) {
          report(`kept\t${relative(root, join(path, stage.name))}\treason=artifact-manifest-invalid:${error.message}`);
        }
      }
    } else {
      const releases = join(path, "compose", "releases");
      try {
        await lstat(releases);
        // The owner's config/current release remains recovery state even if a
        // symlinked or unreadable release root prevents granular inspection.
        result.push({ path, kind: "artifact-owner", keepReason: "artifact-owner" });
        result.push(...(await releaseCandidates(releases)));
      } catch (error) {
        if (error.code !== "ENOENT") {
          result.push({ path, kind: "artifact-owner", keepReason: "release-inspection-failed" });
          report(`kept\t${releases}\treason=release-inspection-failed:${error.message}`);
        }
      }
    }
  }
  // Overlapping manifest paths must never cause a second removal/audit entry.
  return result.filter(
    (candidate, index) =>
      candidate.kind === "artifact-owner" ||
      !result.some(
        (other, otherIndex) =>
          other.kind !== "artifact-owner" &&
          otherIndex !== index &&
          under(candidate.path, other.path) &&
          (candidate.path !== other.path || otherIndex < index),
      ),
  );
}

export async function recheckArtifact(candidate, roots, report) {
  const current = (await Promise.all(roots.map((root) => artifactCandidates(root, report)))).flat();
  return (
    current.find((entry) => entry.path === candidate.path) ?? { ...candidate, keepReason: "artifact-ownership-changed" }
  );
}

/** Bind mounts are host references even when no process currently has a file open. */
export async function dockerReferences(run = execute) {
  try {
    const { stdout } = await run("docker", ["ps", "-aq"], { timeout: 15_000 });
    const ids = stdout.trim().split(/\s+/u).filter(Boolean);
    if (!ids.length) return { roots: [], unknown: false };
    const inspected = await run("docker", ["inspect", "--format", "{{json .Mounts}}", ...ids], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const mounts = inspected.stdout
      .trim()
      .split("\n")
      .flatMap((line) => JSON.parse(line));
    return {
      roots: mounts.filter((mount) => mount.Type === "bind").map((mount) => resolve(mount.Source)),
      unknown: false,
    };
  } catch (error) {
    // A machine without Docker only needs /proc. An installed but inaccessible
    // daemon cannot prove that mounts are unused.
    return { roots: [], unknown: error.code !== "ENOENT" };
  }
}
