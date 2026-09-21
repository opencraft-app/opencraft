import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const PLUGIN_API = "hypernode.runtime-plugin/v1";
const CATALOG_API = "hypernode.runtime-plugins/v1";
const SAFE_ID = /^[a-z][a-z0-9.-]{0,63}$/;
const SAFE_REVISION = /^[a-zA-Z0-9._-]{1,128}$/;
const CAPABILITIES = new Set([
  "app-server", "dashboard", "events", "storage", "thread-projection", "workspace-projection",
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [directoryArg, revision] = process.argv.slice(2);
if (!directoryArg || !revision) fail("usage: npm run promote:plugin -- <plugin-directory> <revision>");
if (!SAFE_REVISION.test(revision)) fail("revision contains unsafe characters");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(process.cwd(), directoryArg);
const directoryInfo = await lstat(directory).catch(() => null);
if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) {
  fail("plugin directory must be a regular non-symlink directory");
}
const manifestPath = join(directory, "plugin.json");
const manifestInfo = await lstat(manifestPath).catch(() => null);
if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) fail("plugin.json must be a regular file");
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  fail(`invalid plugin.json: ${error.message}`);
}
if (manifest.apiVersion !== PLUGIN_API) fail(`plugin apiVersion must be ${PLUGIN_API}`);
if (!SAFE_ID.test(manifest.id ?? "")) fail("plugin id is invalid");
if (!SAFE_REVISION.test(manifest.version ?? "")) fail("plugin version is invalid");
if (typeof manifest.name !== "string" || manifest.name.trim() === "") fail("plugin name is required");
if (typeof manifest.entry !== "string" || manifest.entry === "" || manifest.entry.startsWith("/") || manifest.entry.includes("..")) {
  fail("plugin entry must stay inside the plugin directory");
}
const capabilities = [...new Set((manifest.capabilities ?? []).map(String))].sort();
for (const capability of capabilities) {
  if (!CAPABILITIES.has(capability)) fail(`unsupported capability: ${capability}`);
}
const entry = resolve(directory, manifest.entry);
if (!entry.startsWith(directory + "/")) fail("plugin entry escapes the plugin directory");
const entryInfo = await lstat(entry).catch(() => null);
if (!entryInfo?.isFile() || entryInfo.isSymbolicLink()) fail("plugin entry must be a regular file");

const moduleName = `__hypernode_runtime_plugin_${manifest.id.replaceAll(/[.-]/g, "_")}`;
const descriptor = JSON.stringify({
  apiVersion: PLUGIN_API,
  id: manifest.id,
  name: manifest.name,
  description: typeof manifest.description === "string" ? manifest.description : "",
  version: manifest.version,
  revision,
  capabilities,
});
const output = await build({
  absWorkingDir: root,
  entryPoints: [entry],
  bundle: true,
  write: false,
  platform: "neutral",
  format: "iife",
  target: "es2017",
  metafile: true,
  globalName: moduleName,
  alias: { "cloudflare:sockets": "./policy/src/runtime/cloudflare-sockets.js" },
  footer: { js: `
(() => {
  const descriptor = ${descriptor};
  const apply = ${moduleName}.default ?? ${moduleName}.apply;
  if (typeof apply !== "function") throw new Error("runtime plugin entry must export default or apply");
  globalThis.hypernodeRuntimePluginCandidate = { ...descriptor, apply };
})();
` },
});
const pluginPrefix = directory.slice(root.length + 1).replaceAll("\\", "/") + "/";
const foreignInputs = Object.keys(output.metafile.inputs)
  .map((input) => input.replaceAll("\\", "/"))
  .filter((input) => !input.startsWith(pluginPrefix));
if (foreignInputs.length > 0) {
  fail([
    "runtime plugins must be self-contained and may not bundle Cordis or policy kernel modules",
    ...foreignInputs.map((input) => `  - ${input}`),
  ].join("\n"));
}
const source = output.outputFiles[0].contents;
if (source.length === 0 || source.length > 8 * 1024 * 1024) fail("runtime plugin bundle size is invalid");

const gates = [
  ["npm", ["run", "check:policy"]],
  ["npm", ["run", "test:policy"]],
  ["go", ["test", "./..."]],
];
for (const [command, args] of gates) {
  console.error(`gate: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) fail(`promotion gate failed: ${command} ${args.join(" ")}`);
}

const digest = createHash("sha256").update(source).digest("hex");
const releases = join(root, "policy", "releases");
await mkdir(releases, { recursive: true, mode: 0o750 });
const bundleName = `${manifest.id}-${revision}-${digest.slice(0, 16)}.js`;
const bundlePath = join(releases, bundleName);
await writeFile(bundlePath, source, { mode: 0o640, flag: "wx" }).catch(async (error) => {
  if (error.code !== "EEXIST") throw error;
  const existing = await readFile(bundlePath);
  if (!existing.equals(source)) fail(`immutable release already exists with different content: ${bundleName}`);
});

const catalogPath = join(releases, "catalog.json");
let catalog = { apiVersion: CATALOG_API, generation: 0, plugins: [] };
try {
  catalog = JSON.parse(await readFile(catalogPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") fail(`could not read catalog: ${error.message}`);
}
if (catalog.apiVersion !== CATALOG_API || !Array.isArray(catalog.plugins)) fail("existing runtime plugin catalog is invalid");
const release = {
  apiVersion: PLUGIN_API,
  id: manifest.id,
  name: manifest.name,
  description: typeof manifest.description === "string" ? manifest.description : "",
  version: manifest.version,
  revision,
  capabilities,
  bundle: bundleName,
  sha256: digest,
  enabled: true,
};
catalog = {
  apiVersion: CATALOG_API,
  generation: Number(catalog.generation || 0) + 1,
  plugins: [...catalog.plugins.filter((plugin) => plugin.id !== manifest.id), release]
    .sort((left, right) => left.id.localeCompare(right.id)),
};
const temporary = join(releases, `.catalog-${process.pid}-${Date.now()}.json`);
await writeFile(temporary, JSON.stringify(catalog, null, 2) + "\n", { mode: 0o640, flag: "wx" });
await rename(temporary, catalogPath);
console.log(`promoted ${manifest.id}@${revision} (${digest}) generation=${catalog.generation}`);
