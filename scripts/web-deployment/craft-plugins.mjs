import { constants } from "node:fs";
import { open, readdir, lstat, realpath, mkdir, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { parse } from "acorn";

const idPattern = /^user\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function checkModule(code) {
  const tree = parse(code, { ecmaVersion: "latest", sourceType: "module" });
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (
      ["ImportDeclaration", "ImportExpression", "MetaProperty"].includes(node.type) ||
      (["ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source)
    )
      throw new Error("Craft plugin must be a self-contained ESM bundle");
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(tree);
  if (!tree.body.some((node) => node.type === "ExportDefaultDeclaration"))
    throw new Error("Craft plugin requires a default export");
}

async function boundedFile(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > limit) throw new Error("Craft file is not a bounded regular file");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
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
      throw new Error("Craft file changed while reading or exceeds its limit");
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

/** Only the deployment owner's explicit crafts directory is a trust source.
 * Never execute modules or discover code in arbitrary conversation workspaces. */
export async function discoverCraftPlugins(directory, reserved = new Set(), previous = []) {
  const root = join(directory, "crafts");
  let children;
  try {
    if (!(await lstat(root)).isDirectory()) throw new Error("Craft root must be a real directory");
    children = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { plugins: [], errors: [] };
    throw error;
  }
  const folders = children.filter((child) => !child.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name));
  if (folders.length > 128) throw new Error("Too many craft plugin directories");
  const plugins = [],
    errors = [];
  const canonicalRoot = await realpath(root);
  for (const child of folders) {
    const id = child.name;
    try {
      if (!idPattern.test(id) || !child.isDirectory() || child.isSymbolicLink())
        throw new Error("Craft requires a real user.* directory");
      if (reserved.has(id)) throw new Error("Craft ID conflicts with an explicitly installed plugin");
      const path = join(root, id);
      if ((await realpath(path)) !== join(canonicalRoot, id))
        throw new Error("Craft symlink directories are not supported");
      const manifestBytes = await boundedFile(join(path, "manifest.json"), 64 * 1024);
      const { moduleSha256, ...manifest } = JSON.parse(manifestBytes.toString("utf8"));
      if (
        manifest.id !== id ||
        manifest.manifestVersion !== 1 ||
        manifest.apiVersion !== 1 ||
        manifest.trust !== "trusted" ||
        typeof manifest.name !== "string" ||
        !manifest.name.trim() ||
        typeof manifest.version !== "string" ||
        !manifest.version.trim() ||
        !Array.isArray(manifest.platforms) ||
        !manifest.platforms.includes("web") ||
        Object.hasOwn(manifest, "replaces") ||
        Object.hasOwn(manifest, "branding")
      )
        throw new Error("Invalid craft manifest; internal overrides require operator installation");
      const code = await boundedFile(join(path, "plugin.mjs"), 512 * 1024);
      if (!/^[a-f0-9]{64}$/.test(moduleSha256 ?? "") || digest(code) !== moduleSha256)
        throw new Error("Craft is not sealed or code changed; run craft-plugin.mjs to publish the completed bundle");
      // An editor/Agent writes manifest last (or atomically renames the folder).
      // Read twice so an in-place edit is not published as a mixed snapshot.
      if (
        !(await boundedFile(join(path, "manifest.json"), 64 * 1024)).equals(manifestBytes) ||
        !(await boundedFile(join(path, "plugin.mjs"), 512 * 1024)).equals(code) ||
        (await realpath(path)) !== join(canonicalRoot, id)
      )
        throw new Error("Craft changed while preparing its snapshot");
      const sha256 = digest(code),
        revision = digest(Buffer.concat([manifestBytes, Buffer.from("\0"), code]));
      const entry = `${id}/${revision}/plugin.mjs`;
      const unchanged = previous.find((plugin) => plugin.entry === entry && plugin.sha256 === sha256);
      if (unchanged) {
        plugins.push(unchanged);
        continue;
      }
      checkModule(code.toString("utf8"));
      const publicRoot = join(directory, "public");
      await mkdir(publicRoot, { recursive: true, mode: 0o700 });
      if (!(await lstat(publicRoot)).isDirectory()) throw new Error("Plugin public root must be a real directory");
      const parent = join(publicRoot, id);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      if (!(await lstat(parent)).isDirectory()) throw new Error("Plugin snapshot parent must be a real directory");
      const target = join(parent, revision);
      try {
        if (
          !(await lstat(target)).isDirectory() ||
          !(await boundedFile(join(target, "plugin.mjs"), 512 * 1024)).equals(code)
        )
          throw new Error("Craft snapshot integrity mismatch");
        plugins.push({ manifest, entry, sha256, replaces: [], access: "public" });
        continue;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const temporary = join(parent, ".preparing-" + randomUUID());
      try {
        await mkdir(temporary, { mode: 0o700 });
        const output = await open(join(temporary, "plugin.mjs"), "wx", 0o600);
        try {
          await output.writeFile(code);
          await output.sync();
        } finally {
          await output.close();
        }
        try {
          await rename(temporary, target);
        } catch (error) {
          if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
        }
        // Existing snapshots are immutable; refuse corrupted/preseeded contents.
        if (!(await boundedFile(join(target, "plugin.mjs"), 512 * 1024)).equals(code))
          throw new Error("Craft snapshot integrity mismatch");
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      plugins.push({ manifest, entry, sha256, replaces: [], access: "public" });
    } catch (error) {
      errors.push({ extensionId: id, message: error.message });
      // An unfinished update must not evict the last validated version.
      const retained = previous.find((plugin) => plugin.manifest.id === id);
      if (retained && !reserved.has(id)) plugins.push(retained);
    }
  }
  return { plugins, errors };
}

/** Single-flight request-driven discovery; no watcher/timer survives shutdown.
 * Existing documents keep their generation. A new document discovers updates. */
export async function createUserPluginCatalog(directory, loadInstalled, { intervalMs = 1000, now = Date.now } = {}) {
  let snapshot,
    lastRead = -Infinity,
    inFlight;
  async function refresh() {
    if (snapshot && now() - lastRead < intervalMs) return snapshot;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const errors = [];
      let installed = [],
        crafted = { plugins: [], errors: [] };
      try {
        installed =
          (await loadInstalled(directory, { isolate: true, onDiagnostic: (issue) => errors.push(issue) })) ?? [];
      } catch {
        // Legacy/custom readers can still throw. Optional data never prevents startup.
        errors.push({ extensionId: "*", message: "plugin_installation_unavailable" });
      }
      try {
        crafted = await discoverCraftPlugins(
          directory,
          new Set(installed.map((plugin) => plugin.manifest.id)),
          snapshot?.crafts ?? [],
        );
      } catch {
        // Preserve independently verified installed packages when craft storage fails.
        errors.push({ extensionId: "*", message: "craft_directory_unavailable" });
      }
      const combined = [...installed, ...crafted.plugins];
      if (combined.length > 128) errors.push({ extensionId: "*", message: "plugin_catalog_limit" });
      snapshot = { plugins: combined.slice(0, 128), crafts: crafted.plugins, errors: [...errors, ...crafted.errors] };
      lastRead = now();
      return snapshot;
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }
  await refresh();
  return { refresh, getSnapshot: () => snapshot };
}
