import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
/** Worker loads the pinned WASM runtime lazily. Keep its real dependency closure
 * outside the server bundle; do not silently depend on workstation node_modules. */
export async function copyServerRuntime(destination, roots) {
  const copied = new Set();
  const versions = {};
  async function copy(name, from = createRequire(import.meta.url)) {
    if (copied.has(name)) return;
    copied.add(name);
    let entry;
    try { entry = from.resolve(name); }
    catch {
      // Some ESM-only libraries deliberately expose no require condition.
      for (const directory of from.resolve.paths(name) ?? []) {
        try {
          const candidate = join(directory, name, "package.json");
          if (JSON.parse(await readFile(candidate, "utf8")).name === name) { entry = candidate; break; }
        } catch {}
      }
      if (!entry) throw new Error(`Cannot locate ESM runtime package ${name}`);
    }
    let root = dirname(entry), manifest;
    for (;;) {
      try {
        manifest = JSON.parse(
          await readFile(join(root, "package.json"), "utf8"),
        );
        if (manifest.name === name) break;
      } catch {}
      const parent = dirname(root);
      if (parent === root)
        throw new Error(`Cannot locate runtime package ${name}`);
      root = parent;
    }
    versions[name] = manifest.version;
    await mkdir(dirname(join(destination, name)), { recursive: true });
    await cp(root, join(destination, name), { recursive: true, verbatimSymlinks: true });
    const resolver = createRequire(join(root, "package.json"));
    for (const dependency of Object.keys(manifest.dependencies || {}))
      await copy(dependency, resolver);
  }
  for (const name of roots) await copy(name);
  return Object.fromEntries(
    roots.map(
      (name) => [name, versions[name]],
    ),
  );
}

export const copyMcpAppRuntime = destination => copyServerRuntime(destination, ["quickjs-emscripten-core", "@jitl/quickjs-wasmfile-release-sync"]);
export const copyPiRuntime = destination => copyServerRuntime(destination, ["@earendil-works/pi-coding-agent", "@earendil-works/pi-durable", "@earendil-works/pi-ai", "@earendil-works/chord"]);
