import { createHash } from "node:crypto";
import { requiredStartupModule, startupResourceViolations, type StartupResourcePolicy } from "./startup-resource-policy.vite";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { Plugin } from "vite";

/** Build graph evidence stays outside the distributable, with module identities. */
export function startupResources(policy: StartupResourcePolicy = {}): Plugin {
  return {
    name: "opencraft-startup-resources",
    enforce: "post",
    async writeBundle(options, bundle) {
      const root = resolve(options.dir!);
      const chunks = Object.values(bundle).filter(item => item.type === "chunk");
      const roots = chunks.filter(item => item.isEntry || Object.keys(item.modules).some(id => {
        const module = id.replace(/\?.*$/, "").replaceAll("\\", "/");
        return requiredStartupModule.test(module) || policy.requiredModules?.some(pattern => pattern.test(module));
      }));
      const critical = new Set<string>();
      const visit = (file: string) => {
        if (critical.has(file)) return;
        critical.add(file);
        const chunk = chunks.find(item => item.fileName === file);
        for (const imported of chunk?.imports ?? []) visit(imported);
        const metadata = (chunk as typeof chunk & { viteMetadata?: { importedCss: Set<string> } })?.viteMetadata;
        for (const css of metadata?.importedCss ?? []) critical.add(css);
      };
      roots.forEach(item => visit(item.fileName));
      const report = { schemaVersion: 1, roots: roots.map(item => item.fileName), critical: [...critical].sort(), chunks: chunks.map(item => ({
        file: item.fileName, bytes: Buffer.byteLength(item.code),
        normalizedHash: createHash("sha256").update(item.code.replace(/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:js|css)/g, "<dependency>")).digest("hex"), imports: item.imports, dynamicImports: item.dynamicImports,
        modules: Object.keys(item.modules).map(id => id.replaceAll("\\", "/").replace(/^.*\/opencraft\//, "opencraft/")),
      })), totals: { javascript: 0, css: 0, gzip: 0, brotli: 0 } };
      // Bounded sequential compression avoids competing with bundler memory.
      const encoded = new Map<string, string[]>();
      for (const file of Object.keys(bundle)) {
        if (!/^assets\/.+\.(?:js|css|svg|json)$/.test(file)) continue;
        const raw = await readFile(join(root, file));
        const gzip = gzipSync(raw, { level: 9 });
        const brotli = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } });
        if (critical.has(file)) {
          if (file.endsWith(".js")) report.totals.javascript += raw.length;
          if (file.endsWith(".css")) report.totals.css += raw.length;
          report.totals.gzip += raw.length < 1024 ? raw.length : Math.min(raw.length, gzip.length);
          report.totals.brotli += raw.length < 1024 ? raw.length : Math.min(raw.length, brotli.length);
        }
        if (raw.length < 1024) continue;
        const variants: string[] = [];
        for (const [suffix, bytes] of [[".gz", gzip], [".br", brotli]] as const) {
          if (bytes.length >= raw.length) continue;
          await writeFile(join(root, file + suffix), bytes);
          variants.push(file + suffix);
        }
        encoded.set(file, variants);
      }
      // Optional PDF sidecars must follow their owner into the optional pack.
      const selectionFile = join(root, "optional-assets.json");
      try {
        const selection = JSON.parse(await readFile(selectionFile, "utf8"));
        selection.files = selection.files.flatMap((file: string) => [file, ...encoded.get(file) ?? []]);
        await writeFile(selectionFile, JSON.stringify(selection));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const evidence = join(dirname(root), ".startup", basename(root));
      await mkdir(evidence, { recursive: true });
      await writeFile(join(evidence, "resources.json"), JSON.stringify(report, null, 2));
      const violations = startupResourceViolations(report, policy);
      if (violations.length) this.error(violations.join("\n"));
      console.info("[startup-resources]", JSON.stringify(report.totals));
    },
  };
}
