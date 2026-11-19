import { realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";

export interface ProductPluginBuild {
  readonly id: string;
  readonly version: string;
  readonly registration: string;
  readonly entry: string;
  readonly implementationRoots?: readonly string[];
  readonly locales: readonly { locale: string; label: string; messages: Readonly<Record<string, string>> }[];
}
const canonicalId = (id: string) => {
  if (!id || id.startsWith("\0")) return id;
  const file = id.split("?")[0]!;
  try {
    return realpathSync(file);
  } catch {
    return resolve(file);
  }
};
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Product factories share the application's module graph, but ship separately.
 * Only this explicit build entry can grant trusted product composition access. */
export function productPluginPacks(plugins: readonly ProductPluginBuild[]): Plugin {
  const release = randomUUID(),
    prefix = `__opencraft_product_plugins/${release}`;
  const registration = new Map(plugins.map((plugin) => [canonicalId(plugin.registration), plugin]));
  const roots = new Map(plugins.map((plugin) => [canonicalId(plugin.entry), plugin]));
  let building = false;
  const substituted = new Set<string>();
  return {
    name: "opencraft-product-plugin-packs",
    enforce: "pre",
    config(_config, environment) {
      building = environment.command === "build";
      return { resolve: { dedupe: ["react", "react-dom", "react-intl"] } };
    },
    options(options) {
      if (building && new Set(plugins.map((plugin) => plugin.id)).size !== plugins.length)
        this.error("Duplicate product plugin");
      return options;
    },
    // Retained packs share these URLs with old readers. A bundler's chunk
    // hash may omit late import ordering, so bind every JS chunk to the same
    // immutable release identity as the plugin entry and manifest.
    augmentChunkHash() {
      return release;
    },
    // CSS/media and their precompressed representations share the same retained
    // URL registry. A source hash cannot identify independently encoded bytes.
    // Give those resources the same release lifetime as JS and plugin manifests.
    outputOptions(options) {
      return { ...options, assetFileNames: `assets/a-${release}-[hash][extname]` };
    },
    buildStart() {
      substituted.clear();
      if (building && this.meta.watchMode) this.error("Product plugin packs require a fixed release build");
      if (building)
        for (const plugin of plugins)
          this.emitFile({
            type: "chunk",
            id: resolve(plugin.entry),
            fileName: `${prefix}/${plugin.id}/entry.js`,
            preserveSignature: "strict",
          });
    },
    resolveId(source, importer) {
      if (!building) return;
      const candidate = source.startsWith("/@fs/")
        ? resolve(source.slice("/@fs".length))
        : source.startsWith("/")
          ? resolve(source)
          : source.startsWith(".") && importer
            ? resolve(dirname(importer.split("?")[0]!), source)
            : null;
      const plugin = candidate && registration.get(canonicalId(candidate));
      if (plugin) return "\0opencraft-product-plugin:" + plugin.id;
    },
    load(id) {
      const plugin =
        building &&
        (registration.get(canonicalId(id)) ??
          plugins.find((plugin) => id === "\0opencraft-product-plugin:" + plugin.id));
      if (!plugin) return;
      substituted.add(plugin.id);
      const helper = resolve(import.meta.dirname, "src/runtime/product-plugin-extension.ts");
      return `import { createProductPluginExtension } from ${JSON.stringify(helper)};
export default createProductPluginExtension(${JSON.stringify({
        id: plugin.id,
        version: plugin.version,
        manifest: `/${prefix}/${plugin.id}/manifest.json`,
        locales: plugin.locales,
      })});`;
    },
    writeBundle: {
      order: "post",
      sequential: true,
      async handler(options, bundle) {
        if (!building) return;
        const output = resolve(options.dir!);
        const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
        const visit = (start: string, dynamic: boolean) => {
          const visited = new Set<string>();
          const walk = (file: string) => {
            if (visited.has(file)) return;
            visited.add(file);
            const chunk = bundle[file];
            if (!chunk || chunk.type !== "chunk") return;
            for (const dependency of [
              ...chunk.imports,
              ...(dynamic ? chunk.dynamicImports : []),
              ...((chunk as typeof chunk & { referencedFiles?: string[] }).referencedFiles ?? []),
            ])
              walk(dependency);
            const metadata = (
              chunk as typeof chunk & { viteMetadata?: { importedCss: Set<string>; importedAssets: Set<string> } }
            ).viteMetadata;
            for (const file of [...(metadata?.importedCss ?? []), ...(metadata?.importedAssets ?? [])])
              visited.add(file);
          };
          walk(start);
          return visited;
        };
        const cssAssets = async (files: Set<string>) => {
          for (const path of files)
            if (path.endsWith(".css")) {
              const css = await readFile(resolve(output, path), "utf8");
              for (const match of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) {
                const reference = match[2]!.trim();
                if (/^(?:data:|https?:|\/\/|#)/.test(reference)) continue;
                const resource = decodeURIComponent(
                  new URL(reference, "https://pack.invalid/" + path).pathname.slice(1),
                );
                if (!resource.startsWith("assets/") && !resource.startsWith(prefix + "/"))
                  this.error("Product CSS resource is outside the package namespace");
                files.add(resource);
              }
            }
          return files;
        };
        // All static/dynamic application roots own their reachable modules. A
        // shared React/Context chunk remains in Web and is copied into the pack.
        const application = await cssAssets(
          new Set(
            chunks
              .filter((chunk) => chunk.isEntry && !roots.has(canonicalId(chunk.facadeModuleId ?? "")))
              .flatMap((chunk) => [...visit(chunk.fileName, true)]),
          ),
        );
        const packages = [];
        for (const plugin of plugins) {
          if (!substituted.has(plugin.id)) this.error(`Product plugin registration was not replaced: ${plugin.id}`);
          for (const chunk of chunks.filter((chunk) => application.has(chunk.fileName))) {
            if (
              Object.keys(chunk.modules).some((module) =>
                plugin.implementationRoots?.some((root) => canonicalId(module).startsWith(canonicalId(root) + "/")),
              )
            )
              this.error(`Product plugin implementation leaked into the application: ${plugin.id}`);
          }
          const entry = chunks.find((chunk) => canonicalId(chunk.facadeModuleId ?? "") === canonicalId(plugin.entry));
          if (!entry) this.error(`Missing product plugin entry: ${plugin.id}`);
          const files = [...(await cssAssets(visit(entry.fileName, true)))].sort();
          const css = files.filter((path) => path.endsWith(".css"));
          const path = `${prefix}/${plugin.id}/manifest.json`;
          const manifest = { schemaVersion: 1, id: plugin.id, version: plugin.version, entry: entry.fileName, css };
          await mkdir(dirname(resolve(output, path)), { recursive: true });
          await writeFile(resolve(output, path), JSON.stringify(manifest));
          const inventory = await Promise.all(
            [...files, path].map(async (path) => {
              const bytes = await readFile(resolve(output, path));
              return { path, sha256: digest(bytes), bytes: bytes.length };
            }),
          );
          packages.push({
            id: plugin.id,
            manifest: path,
            files: inventory,
            external: [...files, path].filter((file) => !application.has(file)),
          });
        }
        await writeFile(resolve(output, "product-plugins.json"), JSON.stringify({ schemaVersion: 1, packages }));
      },
    },
  };
}
