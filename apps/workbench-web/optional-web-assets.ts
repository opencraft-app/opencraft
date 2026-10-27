import type { Plugin } from "vite";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { readFileSync, readdirSync } from "node:fs";

const excalidrawFontPrefix = "assets/excalidraw-fonts/";
function excalidrawFonts(): Map<string, string> {
  const base = join(dirname(createRequire(import.meta.url).resolve("@excalidraw/excalidraw")), "fonts");
  const files = new Map<string, string>();
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.set(`${excalidrawFontPrefix}fonts/${relative(base, path).replaceAll("\\", "/")}`, path);
    }
  };
  walk(base);
  return files;
}

// Keep the complete static build runnable. The npm packager alone moves these
// graph-owned files into a separately versioned, optional resource archive.
export function optionalWebAssets(): Plugin {
  return {
    name: "opencraft-optional-web-assets",
    configureServer(server) {
      const fonts = excalidrawFonts();
      server.middlewares.use((request, response, next) => {
        const name = request.url?.split("?", 1)[0]?.replace(/^\//u, "");
        const path = name ? fonts.get(name) : undefined;
        if (!path) return next();
        response.setHeader("content-type", path.endsWith(".woff2") ? "font/woff2" : "text/plain");
        response.end(readFileSync(path));
      });
    },
    transform(code, id) {
      if (!/\/@fontsource-variable\/(?:inter|jetbrains-mono)\/wght(?:-italic)?\.css$/.test(id)) return null;
      return { code: code.split("}").filter(block => /files\/[^/]+-(?:latin|latin-ext)-wght-/.test(block)).map(block => `${block}}`).join("\n"), map: null };
    },
    generateBundle(_options, bundle) {
      const selected = new Set<string>();
      if (Object.values(bundle).some(item => item.type === "chunk" && Object.keys(item.modules).some(id => id.includes("/node_modules/@excalidraw/excalidraw/")))) {
        for (const [fileName, path] of excalidrawFonts()) {
          this.emitFile({ type: "asset", fileName, source: readFileSync(path) });
          selected.add(fileName);
        }
      }
      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk") continue;
        if (!Object.keys(item.modules).some(id => /\/node_modules\/(?:pdfjs-dist|@aiden0z\/pptx-renderer|@extend-ai\/react-(?:xlsx|docx)|@dukelib\/sheets-wasm|@excalidraw\/excalidraw|docx-preview|jszip|fflate)\/|\/plugins\/office-preview\/src\/(?:office-document|legacy-word|paper-viewport|spreadsheet|archive)\.|\/plugins\/structured-preview\/src\/(?!index\.)|\/panels\/(?:workspace-pdf-preview|pdf-assets)\./.test(id))) continue;
        if (item.isEntry) this.error("Preview resources must remain a lazy feature");
        selected.add(item.fileName);
      }
      // Shared static dependencies stay with their existing consumers. Only
      // chunks whose incoming static edges are also optional may be moved.
      let changed = true;
      while (changed) {
        changed = false;
        for (const item of Object.values(bundle)) {
          if (item.type !== "chunk" || selected.has(item.fileName)) continue;
          for (const dependency of item.imports) if (selected.delete(dependency)) changed = true;
        }
      }
      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk" || !selected.has(item.fileName)) continue;
        const metadata = (item as typeof item & { viteMetadata?: { importedAssets: Set<string>; importedCss: Set<string> } }).viteMetadata;
        for (const file of [...metadata?.importedAssets ?? [], ...metadata?.importedCss ?? []]) selected.add(file);
        for (const asset of Object.values(bundle)) {
          if (asset.type === "asset" && item.code.includes(asset.fileName)) selected.add(asset.fileName);
        }
      }
      for (const item of Object.values(bundle)) {
        if (item.type === "chunk" && !selected.has(item.fileName) && item.imports.some(file => selected.has(file))) {
          this.error("A core chunk statically imports optional preview code");
        }
      }
      this.emitFile({ type: "asset", fileName: "optional-assets.json", source: JSON.stringify({ schemaVersion: 1, files: [...selected].sort() }) });
    },
  };
}
