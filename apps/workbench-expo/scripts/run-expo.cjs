const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const appRoot = path.resolve(__dirname, "..");
// Build before Metro observes the static asset reference. A release never
// falls back to a remote executable page when the packaged runtime is absent.
const { resolveProductEntry } = require("../product-entry.cjs");
resolveProductEntry(appRoot);
if (process.env.OPENCRAFT_EXPO_WORKBENCH === "web") {
  require("node:child_process").execFileSync(process.execPath, ["--import", "tsx", path.join(__dirname, "build-web-workbench.mts")], { cwd: path.resolve(appRoot, "../.."), stdio: "inherit" });
}
const mermaidRuntime = path.join(appRoot, "assets", "mobile-chat-mermaid.html");
const mathRuntime = path.join(appRoot, "assets", "mobile-chat-math.html");
const mermaidSources = [
  path.join(appRoot, "package.json"),
  path.join(__dirname, "build-chat-mermaid-runtime.mjs"),
  path.join(appRoot, "src/runtime/chat-mermaid-webview-entry.ts"),
  path.resolve(appRoot, "../../packages/chat-render-react/src/mermaid-source.ts"),
];
if (!fs.existsSync(mermaidRuntime) || mermaidSources.some(source => fs.statSync(source).mtimeMs > fs.statSync(mermaidRuntime).mtimeMs)) {
  const { execFileSync } = require("node:child_process");
  execFileSync(process.execPath, [path.join(__dirname, "build-chat-mermaid-runtime.mjs")], { cwd: appRoot, stdio: "inherit" });
}
const mathSources = [
  path.join(appRoot, "package.json"),
  path.join(__dirname, "build-chat-math-runtime.mjs"),
  path.join(appRoot, "src/runtime/chat-math-webview-entry.ts"),
];
if (!fs.existsSync(mathRuntime) || mathSources.some(source => fs.statSync(source).mtimeMs > fs.statSync(mathRuntime).mtimeMs)) {
  const { execFileSync } = require("node:child_process");
  execFileSync(process.execPath, [path.join(__dirname, "build-chat-math-runtime.mjs")], { cwd: appRoot, stdio: "inherit" });
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
