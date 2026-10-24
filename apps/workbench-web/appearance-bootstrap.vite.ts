import { buildSync } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { runInNewContext } from "node:vm";
import type { WorkbenchPresentation } from "./src/workbench-presentation";

/** Generated from the runtime catalog; no second palette table in index.html. */
export function appearanceBootstrap(presentation: WorkbenchPresentation): Plugin {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  // Vite config dependencies may be externalized and loaded by plain Node.
  // Compile this pure source port explicitly instead of asking Node to execute
  // the workspace's extensionless TypeScript imports (no runtime loader needed).
  const catalog = buildSync({ stdin: {
    contents: `import {resolveBuiltinAppearanceCatalog} from './src/appearance-catalog';
      export default resolveBuiltinAppearanceCatalog(${JSON.stringify(presentation)}).map(entry => ({
        id: entry.descriptor.id,
        ...Object.fromEntries(['light','dark'].map(mode => { const palette = entry.palettes[mode];
          return [mode, {surface:palette.surface, surfaces:{window:palette.surfaces?.window}, material:palette.material, opaqueWindows:palette.opaqueWindows}];
        }))
      }));`,
    resolveDir: directory, loader: "ts",
  }, bundle: true, write: false, format: "cjs", platform: "node", target: "node22" }).outputFiles[0]!.text;
  const compiled: { exports: { default?: unknown } } = { exports: {} };
  runInNewContext(catalog, { module: compiled, exports: compiled.exports }, { timeout: 1000 });
  const colors = compiled.exports.default;
  const serialized = JSON.stringify(colors).replace(/</g, "\\u003c");
  const source = buildSync({ stdin: {
    contents: `import {initializeBootstrapAppearance} from './src/runtime/appearance-bootstrap'; initializeBootstrapAppearance(document, ${serialized});`,
    resolveDir: directory, loader: "ts",
  }, bundle: true, write: false, format: "iife", platform: "browser", target: "es2020", minify: true }).outputFiles[0]!.text;
  return { name: "window-appearance-bootstrap", transformIndexHtml: { order: "pre", handler: html => html.replace("/* OPENCRAFT_BOOTSTRAP_APPEARANCE */", () => source) } };
}
