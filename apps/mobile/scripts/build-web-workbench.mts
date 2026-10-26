import { build, type Plugin } from "vite";
import { createWorkbenchWebConfig } from "../../workbench-web/vite.config";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageModules } from "./packaged-modules.mjs";
import { startPackagedModules } from "./packaged-module-runtime.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const webRoot = path.join(root, "apps/workbench-web");
const appRoot = path.join(root, "apps/mobile");
// Reuse the canonical Web compiler, aliases and browser compatibility checks.
// Keep Web's lazy graph, with native reads restricted to generated package IDs.
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
    const css = Object.values(bundle).filter(item => item.type === "asset" && item.fileName.endsWith(".css"))
      .map(item => typeof item.source === "string" ? item.source : Buffer.from(item.source).toString()).join("\n");
    // Reject emitted executable/style/worker resources outside the document.
    const unbundled = Object.values(bundle).filter(item => item.type === "asset" && !item.fileName.endsWith(".css") && !item.fileName.endsWith(".md"));
    // Default branding is a public-path contract rather than a Vite import.
    // Close this asset too; the packaged document has no HTTP public directory.
    unbundled.push({ type: "asset", fileName: "opencraft-icon.svg", source: await readFile(path.join(webRoot, "public/opencraft-icon.svg")) } as typeof unbundled[number]);
    const { manifest, resources } = packageModules(chunks, unbundled);
    const script = `(${startPackagedModules.toString()})(${JSON.stringify(manifest)});`.replace(/<\/script/giu, "<\\/script");
    const assetRoot = path.join(appRoot, "assets/mobile-resources");
    const publicRoot = path.join(appRoot, "public/mobile-resources");
    await Promise.all([rm(assetRoot, { recursive: true, force: true }), rm(publicRoot, { recursive: true, force: true })]);
    await Promise.all([mkdir(assetRoot, { recursive: true }), mkdir(publicRoot, { recursive: true })]);
    for (const [id, code] of resources) await Promise.all([
      writeFile(path.join(assetRoot, id + ".ocasset"), code),
      writeFile(path.join(publicRoot, id + ".ocasset"), code),
    ]);
    await writeFile(path.join(appRoot, "assets/mobile-resources.cjs"), "module.exports = {\n" + [...resources.keys()].map(id => `${JSON.stringify(id)}: require(${JSON.stringify("./mobile-resources/" + id + ".ocasset")}),`).join("\n") + "\n};\n");
    await writeFile(path.join(appRoot, "assets/mobile-resources.json"), JSON.stringify(manifest));
    const styles = css.replace(/<\/style/giu, "<\\/style");
    const csp = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline'; img-src https: http: data: blob:; font-src data:; connect-src https: http: wss: ws: data: blob:; media-src https: http: data: blob:; worker-src blob: data:; frame-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'none'";
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>OpenCraft</title><style>${styles}</style></head><body><div id="root"></div><script>/*OPENCRAFT_MOBILE_IDENTITY*/</script><script type="module">${script}</script></body></html>`;
    await mkdir(path.join(appRoot, "assets"), { recursive: true });
    await writeFile(path.join(appRoot, "assets/mobile-workbench.html"), html);
    // Expo Web serves the exact same document for browser-based validation.
    await mkdir(path.join(appRoot, "public"), { recursive: true });
    await writeFile(path.join(appRoot, "public/mobile-workbench.html"), html);
    console.log(`Packaged Web Workbench: bootstrap ${Buffer.byteLength(html)} bytes, ${resources.size} lazy modules, total ${[...resources.values()].reduce((total, code) => total + Buffer.byteLength(code), Buffer.byteLength(html))} bytes`);
  } },
};
await build({
  ...config, configFile: false, root: webRoot, base: "./", publicDir: false,
  plugins: [...plugins, capture],
  define: { ...config.define,
    "import.meta.env.VITE_APPSERVER_HOSTS_JSON": JSON.stringify(hosts.length ? JSON.stringify(hosts) : ""),
    "import.meta.env.VITE_APPSERVER_WS_URL": JSON.stringify(endpoint ?? ""),
    // The packaged document's synthetic origin is not a server. Only explicitly
    // configured Host profiles may connect; do not invent a HyperNode there.
    "import.meta.env.VITE_HYPERNODE_PLUGIN": JSON.stringify("disabled"),
  },
  build: {
    ...config.build, write: false, manifest: false, sourcemap: false,
    outDir: path.join(appRoot, ".cache/web-workbench"), copyPublicDir: false,
    assetsInlineLimit: () => true, cssCodeSplit: false, modulePreload: false,
    rolldownOptions: { input: path.join(webRoot, "src/mobile-main.ts"), output: { format: "es" } },
  },
});
