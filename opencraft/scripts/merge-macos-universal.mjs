#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { makeUniversalApp } from "@electron/universal";

const execFileAsync = promisify(execFile);
const runtimeRelativePath = "Contents/Resources/runtime";
const rendererRelativePath = "Contents/Resources/renderer";

// Per-architecture DSH packages and node-pty prebuilds intentionally remain at
// architecture-qualified paths. Both source apps must contain their union so
// @electron/universal can distinguish them from same-path binaries that should
// be combined with lipo.
export const architectureSpecificRuntimeGlob =
  "Contents/Resources/runtime/**/*{arm64,x64}*/**";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copyMissingTree(source, destination) {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) {
    if (!(await exists(destination))) {
      await mkdir(dirname(destination), { recursive: true });
      await symlink(await readlink(source), destination);
    }
    return;
  }
  if (sourceStat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) {
      await copyMissingTree(join(source, entry), join(destination, entry));
    }
    return;
  }
  if (!(await exists(destination))) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

export async function synchronizeRuntimeFiles(x64AppPath, arm64AppPath) {
  const x64Runtime = join(x64AppPath, runtimeRelativePath);
  const arm64Runtime = join(arm64AppPath, runtimeRelativePath);
  await Promise.all([access(x64Runtime), access(arm64Runtime)]);
  await copyMissingTree(x64Runtime, arm64Runtime);
  await copyMissingTree(arm64Runtime, x64Runtime);
  // npm's internal installation inventory is host-specific and is not consumed
  // at runtime. Keeping it would make otherwise equivalent native packages
  // fail the universal plain-file equality check.
  await Promise.all([
    rm(join(x64Runtime, "dsh/node_modules/.package-lock.json"), { force: true }),
    rm(join(arm64Runtime, "dsh/node_modules/.package-lock.json"), { force: true }),
  ]);
}

// The renderer is architecture-independent, but Vite's content-hashed chunk
// names can differ when it resolves platform-specific optional dependencies on
// the two native runners. Use the x64 renderer as the canonical copy so the
// universal merge compares one deterministic resource tree while retaining the
// architecture-specific native runtimes from both apps.
export async function synchronizeRendererFiles(x64AppPath, arm64AppPath) {
  const x64Renderer = join(x64AppPath, rendererRelativePath);
  const arm64Renderer = join(arm64AppPath, rendererRelativePath);
  await Promise.all([access(x64Renderer), access(arm64Renderer)]);
  await rm(arm64Renderer, { recursive: true, force: true });
  await copyMissingTree(x64Renderer, arm64Renderer);
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function listFiles(root, current = root, result = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) await listFiles(root, path, result);
    else if (entry.isFile()) result.push(relative(root, path));
  }
  return result;
}

async function assertMatchingRuntimeInventory(x64AppPath, arm64AppPath) {
  const x64Runtime = join(x64AppPath, runtimeRelativePath);
  const arm64Runtime = join(arm64AppPath, runtimeRelativePath);
  const [x64Files, arm64Files] = await Promise.all([
    listFiles(x64Runtime),
    listFiles(arm64Runtime),
  ]);
  x64Files.sort();
  arm64Files.sort();
  if (x64Files.join("\n") !== arm64Files.join("\n")) {
    throw new Error("macOS architecture packages have different runtime file inventories after synchronization");
  }
  for (const path of x64Files) {
    if (!/(?:arm64|x64)/u.test(path)) continue;
    const [x64Hash, arm64Hash] = await Promise.all([
      sha256(join(x64Runtime, path)),
      sha256(join(arm64Runtime, path)),
    ]);
    if (x64Hash !== arm64Hash) {
      throw new Error(`Architecture-qualified runtime file differs across source apps: ${path}`);
    }
  }
}

export async function mergeMacosUniversal({ x64AppPath, arm64AppPath, outputAppPath }) {
  const x64 = resolve(x64AppPath);
  const arm64 = resolve(arm64AppPath);
  const output = resolve(outputAppPath);
  await synchronizeRuntimeFiles(x64, arm64);
  await synchronizeRendererFiles(x64, arm64);
  await assertMatchingRuntimeInventory(x64, arm64);
  await makeUniversalApp({
    x64AppPath: x64,
    arm64AppPath: arm64,
    outAppPath: output,
    force: true,
    mergeASARs: true,
    x64ArchFiles: architectureSpecificRuntimeGlob,
  });
  const executable = join(output, "Contents/MacOS/OpenCraft");
  const { stdout } = await execFileAsync("lipo", ["-archs", executable]);
  const architectures = new Set(stdout.trim().split(/\s+/u));
  if (!architectures.has("x86_64") || !architectures.has("arm64")) {
    throw new Error(`Merged OpenCraft executable is not universal: ${stdout.trim()}`);
  }
  return output;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Usage: merge-macos-universal --x64 <app> --arm64 <app> --output <app>");
    }
    values.set(key.slice(2), value);
  }
  for (const key of ["x64", "arm64", "output"]) {
    if (!values.has(key)) throw new Error(`Missing --${key}`);
  }
  return values;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = parseArguments(process.argv.slice(2));
  const output = await mergeMacosUniversal({
    x64AppPath: values.get("x64"),
    arm64AppPath: values.get("arm64"),
    outputAppPath: values.get("output"),
  });
  process.stdout.write(`[opencraft] universal macOS app created at ${output}\n`);
}
