import { packageDigest } from "@opencraft/runtime-plugin-host/package-vfs";

const entry = "workbench/assets-plugin.mjs";
const maxBytes = 512 * 1024;
const prefix = "/__opencraft_workbench_assets_plugin/";

export async function readWorkbenchAssetsPlugin(vfs) {
  if (!vfs.listFiles().includes(entry)) return undefined;
  const bytes = vfs.readFile(entry);
  if (!bytes.length || bytes.length > maxBytes) throw Error("Invalid Workbench Assets plugin size");
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const sha256 = await packageDigest(bytes);
  return { bytes, sha256 };
}

export function injectWorkbenchAssetsPlugin(html, { sha256 }) {
  return html.replace(/<head(?:\s[^>]*)?>/iu, head =>
    head + `<script id="opencraft-workbench-assets-plugin" type="application/json">${JSON.stringify({ apiVersion: 1, sha256 })}</script>`);
}

export function serveWorkbenchAssetsPlugin(request, response, url, { sha256, bytes }) {
  if (!url.pathname.startsWith(prefix)) return false;
  if (url.pathname !== `${prefix}${sha256}.mjs` || url.search) {
    response.writeHead(404, { "cache-control": "no-store" }).end();
  } else if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" }).end();
  } else {
    // Only the current selection is available through the normal instance gate.
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": bytes.byteLength,
      "content-type": "text/javascript; charset=utf-8",
      "x-content-type-options": "nosniff",
    }).end(request.method === "HEAD" ? undefined : bytes);
  }
  return true;
}
