import type { Plugin, ResolvedConfig } from "vite";
import type { OutputBundle, OutputChunk } from "rolldown";
import { requiredStartupModule, type StartupResourcePolicy } from "./startup-resource-policy.vite";

const bootstrapModule = /\/apps\/workbench-web\/src\/(?:main-bootstrap\.ts|main\.tsx|workbench-entry\.ts)(?:\?.*)?$/;
const settingsModule = /\/apps\/workbench-web\/src\/components\/settings-page\.tsx$/;

/** Public URLs only: private module identities stay in the existing startup report. */
export function startupResourceHints(policy: StartupResourcePolicy = {}): Plugin {
  let config: ResolvedConfig;
  return {
    name: "opencraft-startup-resource-hints",
    apply: "build",
    configResolved(value) { config = value; },
    generateBundle: {
      order: "post",
      handler(_options, bundle: OutputBundle) {
        const html = bundle["index.html"];
        if (!html || html.type !== "asset") return;
        const chunks = Object.values(bundle).filter((item): item is OutputChunk => item.type === "chunk");
        const matches = (chunk: OutputChunk, pattern: RegExp) => Object.keys(chunk.modules).some(id => pattern.test(id.replaceAll("\\", "/")));
        const roots = chunks.filter(chunk => chunk.isEntry || matches(chunk, bootstrapModule)
          || matches(chunk, requiredStartupModule) || policy.requiredModules?.some(pattern => matches(chunk, pattern)));
        const closure = (entries: readonly OutputChunk[]) => {
          const files = new Set<string>();
          const visit = (file: string) => {
            if (files.has(file)) return;
            files.add(file);
            const chunk = bundle[file];
            if (chunk?.type !== "chunk") return;
            for (const dependency of chunk.imports) visit(dependency);
            const metadata = chunk as OutputChunk & { viteMetadata?: { importedCss?: Set<string> } };
            for (const css of metadata.viteMetadata?.importedCss ?? []) files.add(css);
          };
          entries.forEach(chunk => visit(chunk.fileName));
          return files;
        };
        const critical = closure(roots);
        const url = (file: string) => `${config.base}${file}`;
        const hints = new Map<string, string>();
        for (const chunk of roots) hints.set(url(chunk.fileName), "modulepreload");
        for (const file of critical) if (file.endsWith(".css")) hints.set(url(file), "style");
        let source = String(html.source);
        const tags = [...hints].filter(([href]) => !source.includes(`href="${href}"`)).map(([href, kind]) => kind === "modulepreload"
          ? `<link rel="modulepreload" crossorigin href="${href}">`
          : `<link rel="preload" as="${kind}" href="${href}">`);
        // Settings intent has a small per-document transfer budget, independent
        // of execution/activation. Heavy preview engines stay behind demand edges.
        const settings = chunks.filter(chunk => matches(chunk, settingsModule));
        const intent: string[] = [];
        let bytes = 0;
        for (const file of closure(settings)) {
          if (critical.has(file) || !/^assets\/[^/]+\.(?:js|css)$/.test(file) || intent.length >= 12) continue;
          const item = bundle[file];
          if (!item) continue;
          const size = item.type === "chunk" ? Buffer.byteLength(item.code) : Buffer.byteLength(item.source);
          if (bytes + size > 512_000) continue;
          bytes += size; intent.push(url(file));
        }
        const data = JSON.stringify({ schemaVersion: 1, intents: { settings: intent } }).replaceAll("<", "\\u003c");
        source = source.replace("</head>", `${tags.join("\n")}\n<script id="opencraft-resource-hints" type="application/json">${data}</script>\n</head>`);
        html.source = source;
      },
    },
  };
}
