#!/usr/bin/env node
import { existsSync as existsSyncEntry, readFileSync, realpathSync as realpathSyncEntry } from 'node:fs';
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyElectronDistribution } from "./electron-distribution.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const electronAppRoot = resolve(repositoryRoot, "apps/desktop");
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

// The fork's patches serve the Linux server browser runtime; the desktop app
// does not call them. Until macOS and Windows have native build runners, their
// desktop packages may use stock Electron at the fork's upstream version, but
// only when OPENCRAFT_ELECTRON_STOCK_DESKTOP=1 is set explicitly. Linux desktop
// and every browser runtime still require the verified fork.
export const STOCK_DESKTOP_PLATFORMS = Object.freeze(["darwin", "win32"]);

export function forkUpstreamElectronVersion() {
  return JSON.parse(readFileSync(resolve(repositoryRoot, "vendor/electron/fork.json"), "utf8")).version;
}

export function stockDesktopRequested(environment, target) {
  if (environment.OPENCRAFT_ELECTRON_STOCK_DESKTOP !== "1") return false;
  if (!STOCK_DESKTOP_PLATFORMS.includes(target.platform)) {
    throw new Error(`Stock Electron is only allowed for macOS and Windows desktop packages; ${target.platform} requires the verified fork`);
  }
  return true;
}

export async function packageBuilderArguments(
  args = process.argv.slice(2),
  environment = process.env,
  runtime = {},
) {
  const target = packageTarget(args, runtime);
  if (stockDesktopRequested(environment, target)) {
    return [...args.filter(arg => !arg.startsWith("--config.electronDist") && !arg.startsWith("--config.electronVersion")),
      `--config.electronVersion=${forkUpstreamElectronVersion()}`];
  }
  const selected = electronDistributionForTarget(environment, target);
  const distribution = selected.path;
  if (!distribution) {
    if (target.platform === "linux" && args.includes("AppImage")) {
      throw new Error(`Linux AppImage packaging requires the verified fork in ${selected.key}`);
    }
    throw new Error(
      `Electron release packaging requires ${selected.key}; `
      + "only verified repository-owned Electron distributions can be packaged",
    );
  }
  const verified = await verifyElectronDistribution(
    distribution,
    resolve(repositoryRoot, "vendor/electron/fork.json"),
    target,
  );
  return [...args, `--config.electronDist=${verified.distribution}`, `--config.electronVersion=${verified.marker.electronVersion}`];
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

if (process.argv[1] && existsSyncEntry(process.argv[1]) && realpathSyncEntry(process.argv[1]) === realpathSyncEntry(new URL(import.meta.url))) {
  await packageElectronDesktop();
}
