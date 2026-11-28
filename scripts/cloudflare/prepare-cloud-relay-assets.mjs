// Prepare the hostless OpenCraft Web Workbench static bundle for Cloud Relay (`ASSETS` Offload 1).
// Usage: node scripts/cloudflare/prepare-cloud-relay-assets.mjs <web-dist> <assets-dir>
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { injectWebsiteDeploymentConfig } from "../../apps/headless-server/src/workbench-web-server.mjs";

const [source, output, ...extra] = process.argv.slice(2);
if (!source || !output || extra.length) {
  throw new Error("Expected a Web build directory and a new output directory");
}
const build = resolve(source);
const assets = resolve(output);
const html = await readFile(join(build, "index.html"), "utf8");
if (html.includes('id="opencraft-deployment-config"')) {
  throw new Error("Expected a hostless Web build");
}
const index = injectWebsiteDeploymentConfig(html, {
  hosts: [],
  builtinAgents: false,
  hypernode: false,
});
await mkdir(assets);
await cp(build, assets, { recursive: true, filter: (path) => !/\.(?:map|br|gz)$/u.test(path) });
await writeFile(join(assets, "index.html"), index);
