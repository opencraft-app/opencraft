import { build, type Plugin } from "vite";
import { createWorkbenchWebConfig } from "../../workbench-web/vite.config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageResourceGraph } from "./packaged-resources.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const webRoot = path.join(root, "apps/workbench-web");
const appRoot = path.join(root, "apps/mobile");
// Reuse the canonical Web compiler, aliases and browser compatibility checks.
// This target packages the entire graph, so Web's lazy-download/startup budget
// is measured separately and is not weakened by this build.
process.env.OPENCRAFT_BUILD_TARGET = "mobile";
const config = createWorkbenchWebConfig({ mode: "production", command: "build" }, { pluginBranding: false });
const plugins = (config.plugins ?? []).flat().filter(plugin => plugin && !(typeof plugin === "object" && "name" in plugin
  && ["opencraft-startup-resources", "opencraft-optional-web-assets", "opencraft-preview-bridge-asset", "opencraft-release-metadata"].includes(plugin.name)));
const endpoint = process.env.EXPO_PUBLIC_APPSERVER_WS_URL?.trim();
if (endpoint) {
  const url = new URL(endpoint);
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Mobile AppServer must be a credential-free ws/wss URL");
}
const hostId = process.env.EXPO_PUBLIC_APPSERVER_HOST_ID?.trim() || "local";
const hosts = endpoint ? [{ hostId, label: "AppServer", kind: "remote-control", url: endpoint }] : [];
const capture: Plugin = {
  name: "opencraft-packaged-mobile-workbench",
  enforce: "post",
  generateBundle: { order: "post", async handler(_options, bundle) {
    const chunks = Object.values(bundle).filter(item => item.type === "chunk");
    if (chunks.length !== 1 || chunks[0]!.imports.length || chunks[0]!.dynamicImports.some(file => file !== chunks[0]!.fileName)) throw new Error("Mobile Workbench must contain its complete module graph: " + JSON.stringify(chunks.map(item => ({ file: item.fileName, imports: item.imports, dynamic: item.dynamicImports }))));
    if (chunks[0]!.code.includes(chunks[0]!.fileName)) throw new Error("Mobile document references a separate copy of itself");
    const css = Object.values(bundle).filter(item => item.type === "asset" && item.fileName.endsWith(".css"))
      .map(item => typeof item.source === "string" ? item.source : Buffer.from(item.source).toString()).join("\n");
    // Reject emitted executable/style/worker resources outside the document.
    const unbundled = Object.values(bundle).filter(item => item.type === "asset" && !item.fileName.endsWith(".css") && !item.fileName.endsWith(".md"));
    const script = packageResourceGraph(chunks[0]!.code, unbundled).replace(/<\/script/giu, "<\\/script");
    const styles = css.replace(/<\/style/giu, "<\\/style");
    const csp = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline'; img-src https: http: data: blob:; font-src data:; connect-src https: http: wss: ws: data: blob:; media-src https: http: data: blob:; worker-src blob: data:; frame-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'none'";
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>OpenCraft</title><style>${styles}</style></head><body><div id="root"></div><script>/*OPENCRAFT_MOBILE_IDENTITY*/</script><script type="module">${script}</script></body></html>`;
    await mkdir(path.join(appRoot, "assets"), { recursive: true });
    await writeFile(path.join(appRoot, "assets/mobile-workbench.html"), html);
    // Expo Web serves the exact same document for browser-based validation.
    await mkdir(path.join(appRoot, "public"), { recursive: true });
    await writeFile(path.join(appRoot, "public/mobile-workbench.html"), html);
    console.log(`Packaged Web Workbench: ${Buffer.byteLength(html)} bytes`);
  } },
};
await build({
  ...config, configFile: false, root: webRoot, base: "./", publicDir: false,
  plugins: [...plugins, capture],
  define: { ...config.define,
    "import.meta.env.VITE_APPSERVER_HOSTS_JSON": JSON.stringify(hosts.length ? JSON.stringify(hosts) : ""),
    "import.meta.env.VITE_APPSERVER_WS_URL": JSON.stringify(endpoint ?? ""),
  },
  build: {
    ...config.build, write: false, manifest: false, sourcemap: false,
    outDir: path.join(appRoot, ".cache/web-workbench"), copyPublicDir: false,
    assetsInlineLimit: () => true, cssCodeSplit: false, modulePreload: false,
    rolldownOptions: { input: path.join(webRoot, "src/mobile-main.ts"), output: { format: "es", codeSplitting: false } },
  },
});
