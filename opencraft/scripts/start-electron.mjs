#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronAppRoot = resolve(repositoryRoot, "apps/workbench-electron");

export function electronAppEnvironment(source = process.env) {
  const environment = { ...source };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

export function electronLaunchSpec(args = [], environment = process.env) {
  const executable = require("electron");
  if (typeof executable !== "string" || executable.length === 0) {
    throw new Error("The Electron package did not resolve to an executable path");
  }
  return {
    executable,
    args: [electronAppRoot, ...args],
    options: {
      cwd: repositoryRoot,
      env: electronAppEnvironment(environment),
      stdio: "inherit",
    },
  };
}

export async function startElectron(args = process.argv.slice(2), {
  environment = process.env,
  spawnImpl = spawn,
} = {}) {
  const launch = electronLaunchSpec(args, environment);
  const child = spawnImpl(launch.executable, launch.args, launch.options);
  await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`Electron preview exited (${signal ?? code})`)));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startElectron();
}
