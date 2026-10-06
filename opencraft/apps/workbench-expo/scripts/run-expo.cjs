const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const appRoot = path.resolve(__dirname, "..");
const botRuntime = path.join(appRoot, "assets", "mobile-bot-runtime.html");
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
if (!fs.existsSync(botRuntime) && process.argv.slice(2).some(value => value === "run:ios" || value === "export:embed")) {
  console.error("Missing generated iOS Bot runtime. From opencraft/ run: npm run build:mobile-bot-runtime --workspace @opencraft/workbench-expo");
  process.exit(1);
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
