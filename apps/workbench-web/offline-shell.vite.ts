import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

/** Public build bytes only. Account data and runtime HTML are never an offline artifact. */
export function offlineShell(buildId: string): Plugin {
  return {
    name: "opencraft-offline-shell", apply: "build", enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const html = bundle["index.html"];
        if (!html || html.type !== "asset") return;
        const optional = bundle["optional-assets.json"];
        const excluded = new Set<string>(optional?.type === "asset" ? JSON.parse(String(optional.source)).files : []);
        const files = Object.values(bundle).filter(item => !excluded.has(item.fileName)
          && (/^assets\/.+\.(?:js|css|woff2?|svg|wasm|json)$/u.test(item.fileName)
            || /^(?:assets\/brand-|plugin-assets\/).+\.(?:svg|png|ico|webmanifest)$/u.test(item.fileName)
            || /^[^/]+\.(?:svg|ico|webmanifest)$/u.test(item.fileName)));
        const icon = readFileSync(new URL("./public/opencraft-icon.svg", import.meta.url));
        const bytes = icon.byteLength + files.reduce((sum, item) => sum + (item.type === "chunk" ? Buffer.byteLength(item.code) : Buffer.byteLength(item.source)), 0);
        if (bytes > 64 * 1024 * 1024) this.error("Offline application shell exceeds its 64 MiB budget");
        const names = [...files.map(item => item.fileName), "opencraft-icon.svg", "opencraft-offline.html"];
        this.emitFile({ type: "asset", fileName: "opencraft-offline.html", source: String(html.source) });
        const template = readFileSync(new URL("./offline-shell-worker.js", import.meta.url), "utf8");
        this.emitFile({ type: "asset", fileName: "opencraft-app-sw.js", source: template
          .replace('"__OPENCRAFT_BUILD__"', JSON.stringify(buildId)).replace('"__OPENCRAFT_FILES__"', JSON.stringify(names)) });
        this.emitFile({ type: "asset", fileName: "offline-shell.json", source: JSON.stringify({ schemaVersion: 1, buildId, bytes, files: names }) });
      },
    },
  };
}
