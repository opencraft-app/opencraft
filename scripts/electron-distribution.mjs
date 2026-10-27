import { access, lstat, readFile, readdir, readlink, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, normalize, sep } from "node:path";

export function electronExecutableName(platform = process.platform) {
  if (platform === "darwin") return join("Electron.app", "Contents", "MacOS", "Electron");
  return platform === "win32" ? "electron.exe" : "electron";
}

export function electronExecutablePath(distribution, platform = process.platform) {
  if (typeof distribution !== "string" || !isAbsolute(distribution)) {
    throw new Error("OPENCRAFT_ELECTRON_DISTRIBUTION must be an absolute path");
  }
  return join(distribution, electronExecutableName(platform));
}

async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function inventory(directory, relativePath = "") {
  const entries = [];
  for (const entry of await readdir(join(directory, relativePath), { withFileTypes: true })) {
    const child = relativePath ? join(relativePath, entry.name) : entry.name;
    if (child === "opencraft-electron-desktop-artifact.json") continue;
    const absolute = join(directory, child);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      entries.push({ path: child.split(sep).join("/"), type: "symlink", target: await readlink(absolute) });
    } else if (info.isDirectory()) {
      entries.push(...await inventory(directory, child));
    } else if (info.isFile()) {
      entries.push({
        path: child.split(sep).join("/"),
        type: "file",
        size: info.size,
        sha256: await sha256(absolute),
      });
    } else {
      throw new Error(`Unsupported Electron distribution entry: ${child}`);
    }
  }
  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function validateInventoryPath(path) {
  if (typeof path !== "string" || !path || path.startsWith("/")
    || normalize(path).startsWith(`..${sep}`) || path.includes("\\")) {
    throw new Error("Electron distribution inventory contains an invalid path");
  }
}

/** Verify a native fork distribution before it is used by desktop packaging. */
export async function verifyElectronDistribution(distribution, forkDefinition, {
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const executable = electronExecutablePath(distribution, platform);
  const markerPath = join(distribution, "opencraft-electron-desktop-artifact.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  const fork = JSON.parse(await readFile(forkDefinition, "utf8"));
  await access(executable);
  const executableStat = await stat(executable);
  if (!executableStat.isFile()) throw new Error("Electron fork executable is not a file");
  if (marker.schemaVersion !== 1 || marker.platform !== platform || marker.arch !== arch
    || marker.electronVersion !== fork.version || marker.chromiumVersion !== fork.chromiumVersion
    || marker.forkDefinitionSha256 !== await sha256(forkDefinition)
    || marker.nativeProbePassed !== true || !Array.isArray(marker.files)
    || marker.executable !== electronExecutableName(platform).split(sep).join("/")) {
    throw new Error("Electron fork distribution provenance mismatch");
  }
  const expectedFiles = marker.files.map((entry) => {
    validateInventoryPath(entry?.path);
    if (entry.type === "file" && (typeof entry.size !== "number" || typeof entry.sha256 !== "string")) {
      throw new Error("Electron distribution file inventory is incomplete");
    }
    if (entry.type === "symlink" && typeof entry.target !== "string") {
      throw new Error("Electron distribution symlink inventory is incomplete");
    }
    if (entry.type !== "file" && entry.type !== "symlink") {
      throw new Error("Electron distribution inventory contains an unknown entry type");
    }
    return entry;
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const actualFiles = await inventory(distribution);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("Electron fork distribution byte inventory mismatch");
  }
  const executableEntry = expectedFiles.find((entry) => entry.path === marker.executable);
  if (!executableEntry || executableEntry.type !== "file"
    || marker.executableSha256 !== executableEntry.sha256) {
    throw new Error("Electron fork executable provenance mismatch");
  }
  return { distribution, executable, marker };
}
