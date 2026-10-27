#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyElectronDistribution } from "./electron-distribution.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronAppRoot = resolve(repositoryRoot, "apps/workbench-electron");
const electronBuilderCli = resolve(repositoryRoot, "node_modules/electron-builder/out/cli/cli.js");

export function packageTarget(args = process.argv.slice(2), {
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const targetPlatform = args.includes("--mac") ? "darwin"
    : args.includes("--win") ? "win32"
      : args.includes("--linux") ? "linux" : platform;
  const targetArch = args.includes("--arm64") ? "arm64"
    : args.includes("--x64") ? "x64" : arch;
  return { platform: targetPlatform, arch: targetArch };
}

export function distributionEnvironmentKey({ platform, arch }) {
  return `OPENCRAFT_ELECTRON_DISTRIBUTION_${platform.toUpperCase()}_${arch.toUpperCase()}`;
}

export function electronDistributionForTarget(environment, target) {
  const targetKey = distributionEnvironmentKey(target);
  return {
    key: Object.prototype.hasOwnProperty.call(environment, targetKey) ? targetKey : "OPENCRAFT_ELECTRON_DISTRIBUTION",
    path: environment[targetKey] ?? environment.OPENCRAFT_ELECTRON_DISTRIBUTION,
  };
}

export async function packageBuilderArguments(
  args = process.argv.slice(2),
  environment = process.env,
  runtime = {},
) {
  const target = packageTarget(args, runtime);
  const selected = electronDistributionForTarget(environment, target);
  const distribution = selected.path;
  if (!distribution) {
    if (environment.OPENCRAFT_ELECTRON_ALLOW_STOCK === "1") return [...args];
    throw new Error(
      `Electron release packaging requires ${selected.key}; `
      + "set OPENCRAFT_ELECTRON_ALLOW_STOCK=1 only for an explicit local stock-runtime diagnostic",
    );
  }
  const verified = await verifyElectronDistribution(
    distribution,
    resolve(repositoryRoot, "vendor/electron/fork.json"),
    target,
  );
  return [...args, `--config.electronDist=${verified.distribution}`];
}

export async function packageElectronDesktop(args = process.argv.slice(2), {
  environment = process.env,
  spawnImpl = spawn,
} = {}) {
  const child = spawnImpl(process.execPath, [electronBuilderCli, ...await packageBuilderArguments(args, environment)], {
    cwd: electronAppRoot,
    env: { ...environment },
    stdio: "inherit",
  });
  await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`Electron desktop packaging failed (${signal ?? code})`)));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packageElectronDesktop();
}
