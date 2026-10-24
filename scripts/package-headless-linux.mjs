#!/usr/bin/env node
import { packageBrowserRuntime } from './package-browser-runtime.mjs';

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile, chmod } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { copyMcpAppRuntime, copyPiRuntime } from "./package-mcp-app-runtime.mjs";
import { copySshRuntime } from "./package-ssh-runtime.mjs";
import { assertHeadlessWebRelease } from "./headless-web-release.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function assertHeadlessBuildHost(platform = process.platform, arch = process.arch) {
  if (platform !== "linux" || arch !== "x64") {
    throw new Error("headless-linux-amd64-tar must be built on native Linux x64");
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

export async function buildHeadlessBundle(output, { headlessEntry = join(repositoryRoot, "scripts/headless-server.mjs") } = {}) {
  await build({entryPoints:[join(repositoryRoot,"apps/opencraft-daemon/src/token-usage-query-worker.ts")],outfile:join(dirname(output),"token-usage-query-worker.mjs"),bundle:true,platform:"node",format:"esm",target:"node26",logLevel:"warning"});
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
  await copyMcpAppRuntime(join(stageRoot, "node_modules"));
  await copyPiRuntime(join(stageRoot, "node_modules"));
  const desktop = JSON.parse(await readFile(join(repositoryRoot, "apps/workbench-electron/package.json"), "utf8"));
  const sourceBase = join(repositoryRoot, "apps/workbench-electron");
  const modules = desktop.build.extraResources.filter((entry) =>
    entry.to.startsWith("runtime/dsh/") && entry.from.startsWith("../local-agent-host/src/"));
  if (modules.length < 10) throw new Error("Desktop DSH capability module inventory is incomplete");
  for (const entry of modules) {
    const target = join(stageRoot, entry.to);
    await mkdir(dirname(target), { recursive: true });
    await cp(resolve(sourceBase, entry.from), target);
  }
  await cp(join(repositoryRoot, "runtime/dsh/package.json"), join(stageRoot, "runtime/dsh/package.json"));
  await cp(join(repositoryRoot, "runtime/dsh/package-lock.json"), join(stageRoot, "runtime/dsh/package-lock.json"));
  await cp(join(repositoryRoot, "runtime/dsh/node_modules"), join(stageRoot, "runtime/dsh/node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  });
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
  await cp(join(repositoryRoot, "scripts/headless-codex-launcher.sh"), join(stageRoot, "runtime/codex/bin/codex"));
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
  assertHeadlessBuildHost();
  const outputOverride = process.env.OPENCRAFT_HEADLESS_PACKAGE_OUTPUT;
  if (outputOverride !== undefined && !isAbsolute(outputOverride)) {
    throw new Error("OPENCRAFT_HEADLESS_PACKAGE_OUTPUT must be absolute");
  }
  const require = createRequire(import.meta.url);
  if (typeof require("node-pty").spawn !== "function") throw new Error("Linux node-pty is unavailable");
  await run("npm", ["run", "prepare:dsh-runtime"]);
  await run("npm", ["ci", "--prefix", join(repositoryRoot, "runtime/codex"), "--workspaces=false", "--omit=dev", "--no-audit", "--no-fund"]);
  await run("npm", ["run", "build:web:release"], {
    env: {
      OPENCRAFT_HEADLESS_SERVER_BUILD: "true",
      VITE_HYPERNODE_PLUGIN: "disabled",
      VITE_APPSERVER_HOSTS_JSON: JSON.stringify(headlessWebHostDefinitions()),
    },
  });
  await assertHeadlessWebRelease(join(repositoryRoot, "apps/workbench-web/dist"));

  const version = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")).version;
  const output = outputOverride
    ?? join(repositoryRoot, "release", `OpenCraft-server-${version}-linux-amd64.tar.gz`);
  const temporary = await mkdtemp(join(tmpdir(), "opencraft-server-package-"));
  const stage = join(temporary, "opencraft-server");
  try {
    await mkdir(join(stage, "bin"), { recursive: true });
    await mkdir(join(stage, "runtime"), { recursive: true });
    await cp(process.execPath, join(stage, "bin/node"));
    await chmod(join(stage, "bin/node"), 0o755);
    await cp(join(repositoryRoot, "scripts/headless-server-launcher.sh"), join(stage, "bin/opencraft-server"));
    await chmod(join(stage, "bin/opencraft-server"), 0o755);
    await buildHeadlessBundle(join(stage, "runtime/server.mjs"), composition);
    await build({ entryPoints: [join(repositoryRoot, 'scripts/human-account.ts')], outfile: join(stage, 'runtime/human-account.mjs'),
      bundle: true, platform: 'node', format: 'esm', target: 'node26' });
    await build({ entryPoints: [join(repositoryRoot, 'scripts/codex-account-reference.ts')], outfile: join(stage, 'runtime/codex-account-reference.mjs'),
      bundle: true, platform: 'node', format: 'esm', target: 'node26' });
    // Optional native installation assets; startup never installs services.
    await cp(join(repositoryRoot, "apps/local-agent-host/native/linux"), join(stage, "runtime/native-desktop"), { recursive: true });
    await cp(join(repositoryRoot, "apps/workbench-web/dist"), join(stage, "web"), {
      recursive: true,
      filter: (path) => !path.endsWith(".map"),
    });
    await copyRuntimeModules(stage);
    await packageBrowserRuntime(join(stage, 'runtime/browser'));
    const versionInfo = JSON.parse(await readFile(join(stage, "web/version.json"), "utf8"));
    const files = await inventory(stage);
    await writeFile(join(stage, "manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      version,
      platform: "linux",
      architecture: "amd64",
      nodeVersion: process.version,
      buildId: versionInfo.buildId,
      files,
    }, null, 2)}\n`);
    await mkdir(dirname(output), { recursive: true });
    await run("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
      "-czf", output, "-C", temporary, "opencraft-server"]);
    await stat(output);
    return output;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] != null
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  packageHeadlessLinux().then((path) => process.stdout.write(`${path}\n`)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
