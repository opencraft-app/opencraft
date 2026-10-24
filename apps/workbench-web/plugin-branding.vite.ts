import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { isApplicationBranding } from "../../packages/extension-contract/src/application-branding";
import { applicationBrandingMetadata } from "./src/runtime/application-branding-metadata";

/** Product assets and initial metadata belong to declared plugin packages. */
export function pluginBranding(workspaceRoot: string, enabled: readonly string[]): Plugin {
  const packages = readdirSync(path.join(workspaceRoot, "plugins")).flatMap(directory => {
    const root = path.join(workspaceRoot, "plugins", directory);
    let metadata;
    try { metadata = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).opencraft; }
    catch { return []; }
    if (!metadata?.webBranding || !metadata?.webAssets) return [];
    const branding: unknown = JSON.parse(readFileSync(path.join(root, metadata.webBranding), "utf8"));
    if (!isApplicationBranding(branding)) throw new Error(`Invalid branding descriptor: ${directory}`);
    return [{ directory, selected: enabled.includes(metadata.extensionId), assets: path.resolve(root, metadata.webAssets), branding }];
  });
  const selected = packages.filter(pkg => pkg.selected);
  if (selected.length > 1) throw new Error("Multiple application branding owners selected");
  const brand = selected[0]?.branding;
  const files = packages.flatMap(pkg => {
    const walk = (root: string, prefix = ""): { fileName: string; source: Buffer }[] => readdirSync(root).flatMap(name => {
      const file = path.join(root, name), relative = path.posix.join(prefix, name);
      return statSync(file).isDirectory() ? walk(file, relative)
        : [{ fileName: `plugin-assets/${pkg.directory}/${relative}`, source: readFileSync(file) }];
    });
    return walk(pkg.assets);
  });
  return {
    name: "application-plugin-branding",
    transformIndexHtml(html) {
      if (!brand) return html;
      const escape = (value: string) => value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
      return {
        html: html.replace(/<title>.*?<\/title>/, `<title>${escape(brand.name)}</title>`).replace(/\s*<link rel="icon"[^>]*>/g, ""),
        tags: [
          ...[["icon", brand.faviconUrl], ["manifest", brand.manifestUrl], ["apple-touch-icon", brand.appleTouchIconUrl],
            ["image_src", brand.share && new URL(brand.share.imageUrl, brand.share.publicOrigin).href]]
            .flatMap(([rel, href]) => href ? [{ tag: "link", attrs: { rel: rel!, href, ...(rel === "manifest" ? { crossorigin: "use-credentials" } : {}) }, injectTo: "head" as const }] : []),
          ...applicationBrandingMetadata(brand).map(({ attribute, key, content }) => ({
            tag: "meta", attrs: { [attribute]: key, content }, injectTo: "head" as const,
          })),
        ],
      };
    },
    generateBundle() { for (const file of files) this.emitFile({ type: "asset", ...file }); },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = files.find(file => `/${file.fileName}` === req.url?.split("?")[0]);
        if (!file) return next();
        res.setHeader("Content-Type", file.fileName.endsWith(".png") ? "image/png" : /\.jpe?g$/.test(file.fileName) ? "image/jpeg" : file.fileName.endsWith(".svg") ? "image/svg+xml" : "application/manifest+json");
        res.end(file.source);
      });
    },
  };
}
