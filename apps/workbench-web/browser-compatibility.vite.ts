import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export function browserSourcePath(workspaceRoot: string, id: string, paths = path.posix): string | null {
  const file = id.split("?")[0];
  const relative = paths.relative(workspaceRoot, file).split(paths.sep).join("/");
  if (!paths.isAbsolute(id) || relative.split("/").includes("node_modules")
    || !/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file) || /\.d\.[cm]?ts$/u.test(file)) return null;
  return relative;
}

/** Capture runtime modules, including lazy chunks, without linting Node-only or
 * type-only imports. Keep this build input out of the distributable web tree. */
export function browserCompatibility(workspaceRoot: string): Plugin {
  return {
    name: "opencraft-browser-compatibility",
    generateBundle() {
      const files = new Set<string>();
      for (const id of this.getModuleIds()) {
        // Trusted downstream entrypoints may import sources outside this workspace.
        // Module ownership follows the actual runtime graph, not its directory.
        const relative = browserSourcePath(workspaceRoot, id, path);
        if (relative !== null) files.add(relative);
      }
      files.add("apps/workbench-web/public/opencraft-host-proxy-sw.js");
      const destination = path.join(workspaceRoot, "node_modules/.cache/opencraft/browser-modules.json");
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, JSON.stringify([...files].sort()));
    },
  };
}
