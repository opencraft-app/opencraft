const path = require("node:path");
const { spawn } = require("node:child_process");

const appRoot = path.resolve(__dirname, "..");
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
