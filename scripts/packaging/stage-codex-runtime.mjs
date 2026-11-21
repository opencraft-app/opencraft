#!/usr/bin/env node
// Stages the pinned native Codex for one desktop package target. The official
// @openai/codex npm package selects a per-platform optional package; the
// desktop ships only that package's vendor tree (binary, resources and PATH
// helpers, in Codex's own layout) and starts the binary directly.
import { spawn } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** npm's os/cpu names for the desktop package targets that ship Codex. */
const CODEX_TARGETS = Object.freeze({
  "darwin/arm64": "codex-darwin-arm64",
  "darwin/x64": "codex-darwin-x64",
  "linux/arm64": "codex-linux-arm64",
  "linux/x64": "codex-linux-x64",
  "win32/arm64": "codex-win32-arm64",
  "win32/x64": "codex-win32-x64",
});

export function codexPlatformPackage({ platform, arch }) {
  const name = CODEX_TARGETS[`${platform}/${arch}`];
  if (!name) throw new Error(`No bundled Codex for ${platform}/${arch}`);
  return `@openai/${name}`;
}

export function codexExecutableName(platform) {
  return platform === "win32" ? "codex.exe" : "codex";
}

function installLockedRuntime(runtime, { platform, arch }) {
  return new Promise((resolvePromise, reject) => {
    // --os/--cpu install the target's optional platform package even when
    // packaging on another host, and never the packaging host's own.
    const child = spawn(
      "npm",
      [
        "ci",
        "--prefix",
        runtime,
        "--workspaces=false",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        `--os=${platform}`,
        `--cpu=${arch}`,
      ],
      { stdio: "inherit", shell: process.platform === "win32" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolvePromise() : reject(new Error(`Codex runtime npm ci failed (${signal ?? code})`)),
    );
  });
}

/**
 * Installs runtime/codex for the target and copies its vendor tree to
 * `<staging>/codex-<arch>`, packaged as `runtime/codex-<arch>/bin/codex[.exe]` beside
 * `codex-resources/`, `codex-path/` and `codex-package.json`.
 */
export async function stageCodexRuntime(
  target,
  {
    root = repositoryRoot,
    staging = resolve(root, "apps/desktop/build/codex-runtime"),
    install = installLockedRuntime,
  } = {},
) {
  // Architecture-qualified, like the other per-architecture runtimes, so a
  // macOS universal merge keeps both trees instead of comparing their files.
  const output = join(staging, `codex-${target.arch}`);
  const runtime = resolve(root, "runtime/codex");
  const manifest = JSON.parse(await readFile(join(runtime, "package.json"), "utf8"));
  const version = manifest.dependencies?.["@openai/codex"];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("runtime/codex must pin an exact @openai/codex version");
  }
  await install(runtime, target);
  const packageRoot = join(runtime, "node_modules", codexPlatformPackage(target));
  const vendor = join(packageRoot, "vendor");
  const triples = await readdir(vendor);
  if (triples.length !== 1) throw new Error(`Expected one Codex vendor target in ${vendor}, found ${triples.length}`);
  const source = join(vendor, triples[0]);
  const layout = JSON.parse(await readFile(join(source, "codex-package.json"), "utf8"));
  if (layout.version !== version) {
    throw new Error(`Installed Codex ${layout.version} does not match the pinned ${version}`);
  }
  const executable = join(source, layout.entrypoint ?? join("bin", codexExecutableName(target.platform)));
  if (!(await stat(executable)).isFile()) throw new Error(`Codex executable is missing at ${executable}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await cp(source, output, { recursive: true, preserveTimestamps: true });
  return { version, target: layout.target, output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [platform = process.platform, arch = process.arch] = process.argv.slice(2);
  const staged = await stageCodexRuntime({ platform, arch });
  console.log(`Staged Codex ${staged.version} (${staged.target}) in ${staged.output}`);
}
