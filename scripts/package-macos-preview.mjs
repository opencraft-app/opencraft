#!/usr/bin/env node
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronAppRoot = resolve(repositoryRoot, "apps/workbench-electron");
const electronBuilderCli = resolve(repositoryRoot, "node_modules/electron-builder/out/cli/cli.js");

export const PREVIEW_APP_ID = "dev.opencraft.workbench.preview";
export const PREVIEW_PRODUCT_NAME = "OpenCraft Preview";

export function previewBuilderArguments(arch) {
  if (arch !== "arm64" && arch !== "x64") throw new Error("macOS preview arch must be arm64 or x64");
  return [
    "--mac",
    "zip",
    `--${arch}`,
    `--config.appId=${PREVIEW_APP_ID}`,
    `--config.productName=${PREVIEW_PRODUCT_NAME}`,
    "--config.directories.output=release/preview",
    "--config.artifactName=OpenCraft-Preview-${version}-${os}-${arch}.${ext}",
  ];
}

export async function packageMacosPreview(arch, { spawnImpl = spawn } = {}) {
  if (process.platform !== "darwin") throw new Error("macOS preview packaging must run on macOS");
  const output = resolve(electronAppRoot, "release/preview");
  await rm(output, { recursive: true, force: true });
  const child = spawnImpl(process.execPath, [electronBuilderCli, ...previewBuilderArguments(arch)], {
    cwd: electronAppRoot,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      OPENCRAFT_MAC_PREVIEW: "1",
    },
    stdio: "inherit",
  });
  await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`macOS preview packaging failed (${signal ?? code})`)));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packageMacosPreview(process.argv[2] || process.arch);
}
