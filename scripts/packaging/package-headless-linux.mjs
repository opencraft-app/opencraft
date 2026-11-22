#!/usr/bin/env node
import { buildAssetsRuntime } from './package-assets-runtime.mjs';
import { buildServerSpacesRuntime } from './package-server-spaces-runtime.mjs';
import { buildOwnerWorkers } from './owner-workers.mjs';
import { buildConnectedAgentHistoryRuntime } from './package-connected-agent-history-runtime.mjs';
import { buildDshRoutingRuntime } from './package-dsh-routing-runtime.mjs';
import { buildTranscriptCacheRuntime } from './package-transcript-cache-runtime.mjs';
import { existsSync as existsSyncEntry, realpathSync as realpathSyncEntry } from 'node:fs';
import { buildTerminalOwnerRuntime } from './package-terminal-runtime.mjs';
import { buildPiShellRuntime } from './package-pi-shell-runtime.mjs';
import { packageBrowserRuntime } from './package-browser-runtime.mjs';
import { verifyRemoteBrowserArtifact } from './remote-browser-artifact.mjs';

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile, chmod } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { copyAllServerRuntime } from "./package-mcp-app-runtime.mjs";
import { copySshRuntime } from "./package-ssh-runtime.mjs";
import { assertHeadlessWebRelease } from "../../apps/headless-server/src/headless-web-release.mjs";
import { buildGitIdentityRuntime } from './package-git-identity-runtime.mjs';
import { buildDshCapabilityPlugin } from './package-dsh-capability-runtime.mjs';
import { buildConversationCli } from './build-conversation-cli.mjs';
import { splitProductPluginPacks } from '../../apps/headless-server/src/web-deployment/product-plugin-packs.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function assertHeadlessBuildHost(platform = process.platform, arch = process.arch, architecture = 'amd64') {
  const expected = architecture === 'amd64' ? 'x64' : architecture === 'arm64' ? 'arm64' : null;
  if (platform !== "linux" || !expected || arch !== expected) {
    throw new Error(`headless-linux-${architecture}-tar must be built on native Linux ${expected ?? architecture}`);
  }
}

export function headlessWebHostDefinitions() {
  return [{
    hostId: "opencraft-server",
    label: "Server",
    kind: "durable",
    executionLocation: "This server",
    url: "/appserver",
    workspaceBrowseRoots: ["/"],
  }];
}

export async function buildHeadlessBundle(output, { headlessEntry = join(repositoryRoot, "apps/headless-server/src/headless-server.mjs"), additionalGitRuntimeEntries = [], assistantEntry = join(repositoryRoot,'apps/personal-assistant/src/runtime/assistant-server.mjs') } = {}) {
  await mkdir(dirname(output), { recursive: true });
  await buildAssetsRuntime(dirname(output),{headless:true});
  await cp(join(repositoryRoot, 'scripts/packaging/craft-plugin.mjs'), join(dirname(output), 'craft-plugin.mjs'));
  await build({ entryPoints: [join(repositoryRoot, "apps/headless-server/src/remote-browser/state.worker.ts")], outfile: join(dirname(output), "browser-state-worker.mjs"), bundle: true, platform: "node", format: "esm", target: "node26", logLevel: "warning" });
  await buildTranscriptCacheRuntime(dirname(output));
  await build({entryPoints:[fileURLToPath(new URL('../../packages/web-push-node/src/store.worker.ts',import.meta.url))],outfile:join(dirname(output),'push-storage-worker.mjs'),bundle:true,platform:'node',format:'esm',target:'node26',logLevel:'warning',banner:{js:"import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);"}});
  await buildOwnerWorkers(dirname(output));
  await buildServerSpacesRuntime(dirname(output));
  await buildDshRoutingRuntime(dirname(output));
  await buildConnectedAgentHistoryRuntime(dirname(output));
  await build({entryPoints:[join(repositoryRoot,'scripts/server-deployment/dsh-consumer-receipts.worker.ts')],outfile:join(dirname(output),'dsh-consumer-receipts-worker.mjs'),bundle:true,platform:'node',format:'esm',target:'node26',logLevel:'warning',banner:{js:"import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);"}});
  await buildGitIdentityRuntime(dirname(output), additionalGitRuntimeEntries);
  await buildPiShellRuntime(dirname(output));
  await build({entryPoints:[join(repositoryRoot,"apps/opencraft-daemon/src/execution-fault.worker.ts")],outfile:join(dirname(output),"execution-fault-worker.mjs"),bundle:true,platform:"node",format:"esm",target:"node26",logLevel:"warning"});
  await buildTerminalOwnerRuntime(dirname(output));
  await build({entryPoints:[join(repositoryRoot,"apps/opencraft-daemon/src/token-usage-query-worker.ts")],outfile:join(dirname(output),"token-usage-query-worker.mjs"),bundle:true,platform:"node",format:"esm",target:"node26",logLevel:"warning",
    // The collector role reaches CJS dependencies (undici) through the core control client.
    banner:{js:"import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);"}});
  await (await import('node:fs/promises')).copyFile(join(repositoryRoot,'apps/personal-assistant/src/adapters/sqlite/schema.sql'),join(dirname(output),'schema.sql'));
  await build({entryPoints:[assistantEntry],outfile:join(dirname(output),'assistant-server.mjs'),bundle:true,platform:'node',format:'esm',target:'node26',external:['@earendil-works/pi-*','@earendil-works/chord'],banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});
  await build({entryPoints:[join(repositoryRoot,"packages/access-control/src/orchestration-runtime.worker.ts")],outfile:join(dirname(output),"orchestration-runtime-worker.mjs"),bundle:true,platform:"node",format:"esm",target:"node26",logLevel:"warning"});
  return build({
    entryPoints: [resolve(headlessEntry)],
    // Product-local packages resolve first; this is a trusted build fallback.
    nodePaths: [join(repositoryRoot, "node_modules")],
    metafile: true,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    external: ["node-pty", "ssh2", "@earendil-works/pi-*", "@earendil-works/chord"],
    banner: { js: "import { createRequire as createOpenCraftRequire } from 'node:module'; const require = createOpenCraftRequire(import.meta.url);" },
    outfile: output,
    logLevel: "warning",
  });
}

export function buildHumanAccountBundle(output) {
  return build({ entryPoints: [join(repositoryRoot, 'scripts/admin/human-account.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'esm', target: 'node26',
    banner: { js: "import { createRequire as createOpenCraftRequire } from 'node:module'; const require = createOpenCraftRequire(import.meta.url);" } });
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...options.env },
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}

async function copyRuntimeModules(stageRoot) {
  await copySshRuntime(join(stageRoot, "node_modules"));
  await copyAllServerRuntime(join(stageRoot, "node_modules"));
  const desktop = JSON.parse(await readFile(join(repositoryRoot, "apps/desktop/package.json"), "utf8"));
  const sourceBase = join(repositoryRoot, "apps/desktop");
  const modules = desktop.build.extraResources.filter((entry) =>
    entry.to.startsWith("runtime/dsh/") && entry.from.startsWith("../local-agent-host/src/"));
  if (modules.length < 10) throw new Error("Desktop DSH capability module inventory is incomplete");
  for (const entry of modules) {
    const target = join(stageRoot, entry.to);
    await mkdir(dirname(target), { recursive: true });
    await cp(resolve(sourceBase, entry.from), target);
  }
  // The DSH bridge ships; the DSH runtime does not. A server that installs DSH
  // points OPENCRAFT_DSH_EXECUTABLE at it; otherwise the Host runs without it.
  await buildDshCapabilityPlugin(join(stageRoot, 'runtime/dsh/opencraft-capability-plugin.mjs'));
  await mkdir(join(stageRoot, "runtime/node_modules"), { recursive: true });
  await cp(join(repositoryRoot, "node_modules/node-pty"), join(stageRoot, "runtime/node_modules/node-pty"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await mkdir(join(stageRoot, "runtime/codex/bin"), { recursive: true });
  await cp(join(repositoryRoot, "runtime/codex/package.json"), join(stageRoot, "runtime/codex/package.json"));
  await cp(join(repositoryRoot, "runtime/codex/package-lock.json"), join(stageRoot, "runtime/codex/package-lock.json"));
  await cp(join(repositoryRoot, "runtime/codex/node_modules"), join(stageRoot, "runtime/codex/node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await cp(join(repositoryRoot, "scripts/packaging/headless-codex-launcher.sh"), join(stageRoot, "runtime/codex/bin/codex"));
  await chmod(join(stageRoot, "runtime/codex/bin/codex"), 0o755);
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function inventory(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(root, path));
    else if (entry.isFile()) files.push({ path: relative(root, path), sha256: await digest(path) });
    else if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      const destination = resolve(dirname(path), target);
      if (isAbsolute(target) || (destination !== root && !destination.startsWith(`${root}${sep}`))) {
        throw new Error(`Escaping symlink in server package: ${path}`);
      }
      files.push({ path: relative(root, path), link: target });
    } else throw new Error(`Unsupported package file: ${path}`);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function packageHeadlessLinux(composition = {}) {
  const architecture = composition.architecture ?? 'amd64';
  assertHeadlessBuildHost(process.platform, process.arch, architecture);
  // Explicit custom distributions must be verified before builds/downloads.
  if (process.env.OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION) await verifyRemoteBrowserArtifact(process.env.OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION, join(repositoryRoot, 'vendor/electron/fork.json'));
  const outputOverride = process.env.OPENCRAFT_HEADLESS_PACKAGE_OUTPUT;
  if (outputOverride !== undefined && !isAbsolute(outputOverride)) {
    throw new Error("OPENCRAFT_HEADLESS_PACKAGE_OUTPUT must be absolute");
  }
  const require = createRequire(import.meta.url);
  if (typeof require("node-pty").spawn !== "function") throw new Error("Linux node-pty is unavailable");
  await run("npm", ["ci", "--prefix", join(repositoryRoot, "runtime/codex"), "--workspaces=false", "--omit=dev", "--no-audit", "--no-fund"]);
  await run("npm", ["run", process.env.OPENCRAFT_CONTAINER_WEB_SCRIPT || "build:web:release"], {
    env: {
      OPENCRAFT_HEADLESS_SERVER_BUILD: "true",
      VITE_HYPERNODE_PLUGIN: "disabled",
      VITE_APPSERVER_HOSTS_JSON: JSON.stringify(headlessWebHostDefinitions()),
    },
  });
  await assertHeadlessWebRelease(join(repositoryRoot, "apps/workbench-web/dist"));

  const version = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")).version;
  const output = outputOverride
    ?? join(repositoryRoot, "release", `OpenCraft-server-${version}-linux-${architecture}.tar.gz`);
  // stageInto: lay the tree out at <stageInto>/opencraft-server and return that
  // directory instead of an archive. The container build copies the tree into
  // its image, so compressing it only to extract it again cost about 75s.
  const stageInto = composition.stageInto;
  if (stageInto !== undefined && !isAbsolute(stageInto)) throw new Error("stageInto must be absolute");
  const temporary = stageInto ?? await mkdtemp(join(tmpdir(), "opencraft-server-package-"));
  const stage = join(temporary, "opencraft-server");
  try {
    await mkdir(join(stage, "bin"), { recursive: true });
    await mkdir(join(stage, "runtime"), { recursive: true });
    await cp(process.execPath, join(stage, "bin/node"));
    await chmod(join(stage, "bin/node"), 0o755);
    await cp(join(repositoryRoot, "scripts/packaging/headless-server-launcher.sh"), join(stage, "bin/opencraft-server"));
    await chmod(join(stage, "bin/opencraft-server"), 0o755);
    await buildHeadlessBundle(join(stage, "runtime/server.mjs"), composition);
    await buildConversationCli(join(stage, 'runtime/opencraft-cli.mjs'));
    await writeFile(join(stage, 'bin/opencraft'), '#!/bin/sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/../runtime/opencraft-cli.mjs" "$@"\n', { mode: 0o755 });
    await buildHumanAccountBundle(join(stage, 'runtime/human-account.mjs'));
    await build({ entryPoints: [join(repositoryRoot, 'scripts/packaging/codex-account-reference.ts')], outfile: join(stage, 'runtime/codex-account-reference.mjs'),
      bundle: true, platform: 'node', format: 'esm', target: 'node26' });
    // Optional native installation assets; startup never installs services.
    await cp(join(repositoryRoot, "apps/local-agent-host/native/linux"), join(stage, "runtime/native-desktop"), { recursive: true });
    await cp(join(repositoryRoot, "apps/workbench-web/dist"), join(stage, "web"), {
      recursive: true,
      filter: (path) => !path.endsWith(".map"),
    });
    const productPlugins = await splitProductPluginPacks(join(stage, 'web'), join(stage, 'runtime/product-plugins'));
    if (productPlugins) await chmod(join(stage, 'runtime/product-plugins/inventory.json'), 0o444);
    await copyRuntimeModules(stage);
    if (composition.includeBrowser !== false) await packageBrowserRuntime(join(stage, 'runtime/browser'));
    const versionInfo = JSON.parse(await readFile(join(stage, "web/version.json"), "utf8"));
    const files = await inventory(stage);
    await writeFile(join(stage, "manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      version,
      platform: "linux",
      architecture,
      nodeVersion: process.version,
      buildId: versionInfo.buildId,
      ...(productPlugins ? { productPlugins } : {}),
      files,
    }, null, 2)}\n`);
    if (stageInto !== undefined) return stage;
    await mkdir(dirname(output), { recursive: true });
    await run("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
      "-czf", output, "-C", temporary, "opencraft-server"]);
    await stat(output);
    return output;
  } finally {
    if (stageInto === undefined) await rm(temporary, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] != null
  && existsSyncEntry(process.argv[1]) && realpathSyncEntry(process.argv[1]) === realpathSyncEntry(new URL(import.meta.url));
if (isMain) {
  packageHeadlessLinux().then((path) => process.stdout.write(`${path}\n`)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
