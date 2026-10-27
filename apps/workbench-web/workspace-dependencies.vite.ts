import path from "node:path";
import type { Plugin } from "vite";
import { isBareModuleSpecifier, isExternalWorkspaceSource } from "../../scripts/workspace-dependencies.mjs";

/** Trusted product source can reuse this build's dependencies. Its own valid
 * dependency always wins; virtual, relative and package-import IDs keep their
 * original resolution. React's existing Vite dedupe remains authoritative. */
export function workspaceDependencies(workspaceRoot: string): Plugin {
  const context = path.join(workspaceRoot, "apps/workbench-web/package.json");
  return {
    name: "opencraft-workspace-dependency-context",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || !isBareModuleSpecifier(source) || !isExternalWorkspaceSource(workspaceRoot, importer)) return null;
      return await this.resolve(source, importer, { ...options, skipSelf: true })
        ?? await this.resolve(source, context, { ...options, skipSelf: true });
    },
  };
}
