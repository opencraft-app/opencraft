import { buildSync } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { resolveBuiltinAppearanceCatalog } from "./src/appearance-catalog";
import type { WorkbenchPresentation } from "./src/workbench-presentation";

/** Generated from the runtime catalog; no second palette table in index.html. */
export function appearanceBootstrap(presentation: WorkbenchPresentation): Plugin {
  const colors = resolveBuiltinAppearanceCatalog(presentation).map(entry => ({
    id: entry.descriptor.id,
    ...Object.fromEntries((["light", "dark"] as const).map(mode => {
      const palette = entry.palettes[mode];
      return [mode, { surface: palette.surface, surfaces: { window: palette.surfaces?.window }, material: palette.material, opaqueWindows: palette.opaqueWindows }];
    })),
  }));
  const serialized = JSON.stringify(colors).replace(/</g, "\\u003c");
  const source = buildSync({ stdin: {
    contents: `import {initializeBootstrapAppearance} from './src/runtime/appearance-bootstrap'; initializeBootstrapAppearance(document, ${serialized});`,
    resolveDir: path.dirname(fileURLToPath(import.meta.url)), loader: "ts",
  }, bundle: true, write: false, format: "iife", platform: "browser", target: "es2020", minify: true }).outputFiles[0]!.text;
  return { name: "window-appearance-bootstrap", transformIndexHtml: { order: "pre", handler: html => html.replace("/* OPENCRAFT_BOOTSTRAP_APPEARANCE */", () => source) } };
}
