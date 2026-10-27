const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const appRoot = path.resolve(__dirname, "..");
// Build before Metro observes the static asset reference. A release never
// falls back to a remote executable page when the packaged runtime is absent.
const { resolveProductEntry } = require("../product-entry.cjs");
resolveProductEntry(appRoot);
if (!process.env.OPENCRAFT_EXPO_PRODUCT_ENTRY) {
  require("node:child_process").execFileSync(process.execPath, ["--import", "tsx", path.join(__dirname, "build-web-workbench.mts")], { cwd: path.resolve(appRoot, "../.."), stdio: "inherit" });
}
const expoPackage = require.resolve("expo/package.json", { paths: [appRoot] });
const expoCli = path.join(path.dirname(expoPackage), "bin", "cli");
const localModules = path.join(appRoot, "node_modules");
const nodePath = [localModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);

const child = spawn(process.execPath, [expoCli, ...process.argv.slice(2)], {
  cwd: appRoot,
  env: {
    ...process.env,
    NODE_PATH: nodePath,
  },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal != null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
