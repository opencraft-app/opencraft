import { constants } from "node:fs";
import { open, lstat, mkdir, rename, rm, readdir, chown, chmod } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, dirname, resolve } from "node:path";

export const RUNTIME_PLUGIN_API = 1;
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const idPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const revisionPattern = /^[a-f0-9]{64}$/u;
const roles = new Set(["gateway", "execution", "hands"]);
const reserved =
  /^\/(?:health|__opencraft_(?:access|actors|auth|account|connectors|push|notifications|hub|files|preview|observe|im|speech|plugins|plugin_catalog))(?:\/|$)/u;
const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value, allowed) => plain(value) && Object.keys(value).every((key) => allowed.includes(key));
export function safePath(value) {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^[A-Za-z0-9_./-]+$/u.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))
  )
    throw Error("Invalid plugin path");
  return value;
}
export function parseManifest(value) {
  if (
    !keys(value, ["schemaVersion", "id", "version", "hostApi", "nodeMajor", "sourceRevision", "roles", "files"]) ||
    value.schemaVersion !== 1 ||
    value.hostApi !== RUNTIME_PLUGIN_API ||
    value.nodeMajor !== 26 ||
    !idPattern.test(value.id ?? "") ||
    value.id.length > 128 ||
    typeof value.version !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u.test(value.version) ||
    typeof value.sourceRevision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.sourceRevision) ||
    !plain(value.roles) ||
    (value.roles.hands && value.roles.execution) ||
    !Object.keys(value.roles).length ||
    Object.keys(value.roles).some((role) => !roles.has(role)) ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > 256
  )
    throw Error("Invalid runtime plugin manifest");
  const names = new Set();
  let total = 0;
  for (const file of value.files) {
    if (
      !keys(file, ["path", "sha256", "size"]) ||
      !revisionPattern.test(file.sha256 ?? "") ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > 8 * 1024 ** 2
    )
      throw Error("Invalid plugin file inventory");
    safePath(file.path);
    if (file.path === "manifest.json" || names.has(file.path)) throw Error("Duplicate plugin file");
    names.add(file.path);
    total += file.size;
  }
  if (total > 32 * 1024 ** 2) throw Error("Plugin package exceeds its budget");
  for (const [role, definition] of Object.entries(value.roles)) {
    if (
      !keys(definition, role === "gateway" ? ["entry", "routes"] : ["entry"]) ||
      !names.has(definition.entry) ||
      !definition.entry.endsWith(".mjs")
    )
      throw Error("Invalid plugin entry");
    if (role === "gateway") {
      if (!Array.isArray(definition.routes) || !definition.routes.length || definition.routes.length > 32)
        throw Error("Invalid plugin routes");
      const routes = new Set();
      for (const route of definition.routes) {
        if (
          !keys(route, ["path", "methods"]) ||
          typeof route.path !== "string" ||
          route.path.length > 256 ||
          !/^\/__[a-zA-Z0-9_/-]+$/u.test(route.path) ||
          route.path.split("/").includes("..") ||
          reserved.test(route.path) ||
          routes.has(route.path) ||
          !Array.isArray(route.methods) ||
          !route.methods.length ||
          new Set(route.methods).size !== route.methods.length ||
          route.methods.some((method) => !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method))
        )
          throw Error("Invalid or reserved plugin route");
        routes.add(route.path);
      }
    }
  }
  return value;
}
function trusted(info, directory) {
  if (
    info.isSymbolicLink() ||
    !(directory ? info.isDirectory() : info.isFile()) ||
    ![0, process.getuid?.()].includes(info.uid) ||
    info.mode & 0o022
  )
    throw Error("Runtime plugin storage is not administrator-owned and read-only to other users");
  // Root Hands never executes a package installed by an unprivileged Gateway UID.
  if (process.getuid?.() === 0 && info.uid !== 0) throw Error("Root runtime requires root-owned plugins");
}
export async function checkedDirectory(path) {
  const info = await lstat(path);
  trusted(info, true);
}
export async function boundedFile(path, limit, enforceOwner = true) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (enforceOwner) trusted(before, false);
    if (!before.isFile() || before.size > limit) throw Error("Plugin file exceeds its budget");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat();
    if (
      length > limit ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw Error("Plugin file changed while reading");
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}
export async function verifyPackage(directory, { revision, enforceOwner = true } = {}) {
  if (enforceOwner) await checkedDirectory(directory);
  else if (!(await lstat(directory)).isDirectory()) throw Error("Plugin package must be a real directory");
  const bytes = await boundedFile(join(directory, "manifest.json"), 256 * 1024, enforceOwner);
  if (revision !== undefined && hash(bytes) !== revision) throw Error("Plugin manifest digest mismatch");
  const manifest = parseManifest(JSON.parse(bytes.toString("utf8"))),
    files = new Map();
  for (const entry of manifest.files) {
    const path = join(directory, entry.path),
      parent = dirname(entry.path);
    let part = directory;
    for (const segment of parent === "." ? [] : parent.split("/")) {
      part = join(part, segment);
      const info = await lstat(part);
      if (enforceOwner) trusted(info, true);
      else if (!info.isDirectory() || info.isSymbolicLink()) throw Error("Plugin directories cannot be links");
    }
    const content = await boundedFile(path, entry.size, enforceOwner);
    if (content.length !== entry.size || hash(content) !== entry.sha256) throw Error("Plugin file digest mismatch");
    files.set(entry.path, content);
  }
  // Undeclared modules/assets must not become an unverified import dependency.
  const declared = new Set(["manifest.json", ...files.keys()]),
    directories = new Set();
  for (const file of files.keys()) {
    let parent = dirname(file);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  async function walk(at, prefix = "") {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        if (!directories.has(name)) throw Error("Undeclared directory in runtime plugin package");
        await walk(join(at, entry.name), name + "/");
      } else if (!entry.isFile() || !declared.has(name))
        throw Error("Undeclared file or link in runtime plugin package");
    }
  }
  await walk(directory);
  return { manifest, revision: hash(bytes), manifestBytes: bytes, files, directory };
}
function jsonConfiguration(value, depth = 0) {
  if (depth > 16) throw Error("Runtime plugin configuration is too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || Object.keys(value).length > 1024)
    throw Error("Invalid plugin configuration value");
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw Error("Invalid plugin configuration key");
    jsonConfiguration(child, depth + 1);
  }
}
export function parseCatalogue(value) {
  if (
    !keys(value, ["schemaVersion", "plugins"]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.plugins) ||
    value.plugins.length > 64
  )
    throw Error("Invalid runtime plugin catalogue");
  const ids = new Set();
  for (const plugin of value.plugins) {
    if (
      !keys(plugin, ["id", "revision", "enabled", "configuration"]) ||
      !idPattern.test(plugin.id ?? "") ||
      plugin.id.length > 128 ||
      ids.has(plugin.id) ||
      !revisionPattern.test(plugin.revision ?? "") ||
      typeof plugin.enabled !== "boolean" ||
      !plain(plugin.configuration) ||
      Object.keys(plugin.configuration).some((role) => !roles.has(role) || !plain(plugin.configuration[role]))
    )
      throw Error("Invalid runtime plugin selection");
    for (const value of Object.values(plugin.configuration)) jsonConfiguration(value);
    ids.add(plugin.id);
  }
  return value;
}
export async function readCatalogue(directory) {
  if (!isAbsolute(directory) || resolve(directory) === "/")
    throw Error("Runtime plugin directory must be absolute and non-root");
  try {
    await checkedDirectory(directory);
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, plugins: [] };
    throw error;
  }
  try {
    return parseCatalogue(
      JSON.parse((await boundedFile(join(directory, "installed.json"), 1024 * 1024)).toString("utf8")),
    );
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, plugins: [] };
    throw error;
  }
}
async function writeDurable(path, bytes, mode, gid) {
  const file = await open(path, "wx", mode);
  try {
    await file.chmod(mode);
    if (gid !== undefined) await file.chown(process.getuid(), gid);
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncDirectory(path) {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
/** Explicit administrator installation, never called by HTTP or craft discovery. */
export async function installRuntimePlugin(source, directory, { enable = false, configuration, gid } = {}) {
  if (
    !isAbsolute(directory) ||
    resolve(directory) === "/" ||
    !isAbsolute(source) ||
    (gid !== undefined && (!Number.isSafeInteger(gid) || gid < 0))
  )
    throw Error("Invalid runtime plugin installation paths");
  // Source is untrusted until the operator chooses it; do not execute/import it here.
  const candidate = await verifyPackage(source, { enforceOwner: false });
  if ((await mkdir(directory, { recursive: true, mode: 0o750 })) !== undefined) await chmod(directory, 0o750);
  await checkedDirectory(directory);
  const lock = join(directory, ".install-lock");
  await mkdir(lock, { mode: 0o700 });
  let temporary;
  try {
    if (gid !== undefined) await chown(directory, process.getuid(), gid);
    const catalogue = await readCatalogue(directory);
    const previous = catalogue.plugins.find((plugin) => plugin.id === candidate.manifest.id);
    const selection = {
      id: candidate.manifest.id,
      revision: candidate.revision,
      enabled: enable,
      configuration: configuration ?? previous?.configuration ?? {},
    };
    const next = parseCatalogue({
      schemaVersion: 1,
      plugins: [...catalogue.plugins.filter((plugin) => plugin.id !== selection.id), selection],
    });
    const packages = join(directory, "packages"),
      parent = join(packages, selection.id);
    for (const path of [packages, parent]) {
      if ((await mkdir(path, { recursive: true, mode: 0o750 })) !== undefined) await chmod(path, 0o750);
      await checkedDirectory(path);
      if (gid !== undefined) await chown(path, process.getuid(), gid);
    }
    const destination = join(parent, candidate.revision);
    let present = false;
    try {
      await lstat(destination);
      present = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (present) await verifyPackage(destination, { revision: candidate.revision });
    else {
      temporary = join(parent, ".stage-" + randomUUID());
      await mkdir(temporary, { mode: 0o750 });
      await chmod(temporary, 0o750);
      if (gid !== undefined) await chown(temporary, process.getuid(), gid);
      const stagedDirectories = new Set([temporary]);
      for (const [path, bytes] of new Map([["manifest.json", candidate.manifestBytes], ...candidate.files])) {
        const target = join(temporary, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o750 });
        let at = dirname(target);
        while (at !== temporary) {
          stagedDirectories.add(at);
          await chmod(at, 0o750);
          if (gid !== undefined) await chown(at, process.getuid(), gid);
          at = dirname(at);
        }
        await writeDurable(target, bytes, 0o640, gid);
      }
      await verifyPackage(temporary, { revision: candidate.revision });
      for (const path of [...stagedDirectories].sort((a, b) => b.length - a.length)) await syncDirectory(path);
      await rename(temporary, destination);
      temporary = undefined;
      await syncDirectory(parent);
    }
    const index = join(directory, ".installed-" + randomUUID());
    try {
      await writeDurable(index, JSON.stringify(next, null, 2) + "\n", 0o640, gid);
      await rename(index, join(directory, "installed.json"));
      await syncDirectory(directory);
    } finally {
      await rm(index, { force: true });
    }
    return { id: selection.id, revision: selection.revision, enabled: selection.enabled };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await rm(lock, { recursive: true });
  }
}

/** Offline compatibility/integrity preflight; never import or activate installed code. */
export async function inspectRuntimePlugins(directory) {
  const catalogue = await readCatalogue(directory),
    selected = [],
    routes = new Set();
  for (const selection of catalogue.plugins.filter((plugin) => plugin.enabled)) {
    for (const path of [join(directory, "packages"), join(directory, "packages", selection.id)])
      await checkedDirectory(path);
    const plugin = await verifyPackage(join(directory, "packages", selection.id, selection.revision), {
      revision: selection.revision,
    });
    if (
      plugin.manifest.id !== selection.id ||
      plugin.manifest.nodeMajor !== Number(process.versions.node.split(".")[0])
    )
      throw Error("Runtime plugin compatibility mismatch");
    for (const route of plugin.manifest.roles.gateway?.routes ?? []) {
      if (routes.has(route.path)) throw Error("Runtime plugin route collision");
      routes.add(route.path);
    }
    selected.push({
      id: selection.id,
      revision: selection.revision,
      version: plugin.manifest.version,
      roles: Object.keys(plugin.manifest.roles),
    });
  }
  return { hostApi: RUNTIME_PLUGIN_API, selected };
}
