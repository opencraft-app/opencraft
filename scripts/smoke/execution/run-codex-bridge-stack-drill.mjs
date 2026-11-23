#!/usr/bin/env node
// One command for the Codex bridge stack drill (smoke-codex-bridge-stack-windows.ts)
// on the platform it runs on: Windows (named pipes, loopback native listener),
// Linux or macOS (Unix sockets). Used by .github/workflows/windows-codex-bridge.yml.
//
//   npm run build --workspace @opencraft/opencraft-daemon
//   node scripts/smoke/execution/run-codex-bridge-stack-drill.mjs [--node <runtime>]
//
// It stages the pinned native Codex from runtime/codex (npm ci against its lock),
// copies the daemon's codex-bridge programs with the Core replaced by the drill
// Core (loopback model only), bundles the drill and runs it on Electron's own
// Node (ELECTRON_RUN_AS_NODE), the runtime the packaged daemon uses. A local
// stand-in model answers; no account, credential or network service is used.
// Output, state and the result file go to .local/codex-bridge-drill/<time>/.
import { spawn } from "node:child_process";
import { cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import {
  daemonDist,
  drillCodexExecutable,
  prepareDrillPrograms,
  repositoryRoot as root,
} from "./codex-bridge-drill-setup.mjs";

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const out = join(root, ".local/codex-bridge-drill", new Date().toISOString().replace(/[:.]/gu, "-"));
const programs = join(out, "programs"),
  drill = join(out, "drill"),
  state = join(out, "state");
await mkdir(drill, { recursive: true });
await mkdir(state, { recursive: true });
await prepareDrillPrograms(programs);
const codex = await drillCodexExecutable();
await build({
  entryPoints: [join(root, "scripts/smoke/execution/smoke-codex-bridge-stack-windows.ts")],
  bundle: true,
  platform: "node",
  target: "node24",
  external: ["node-pty"],
  logLevel: "warning",
  format: "esm",
  outfile: join(drill, "drill.mjs"),
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
// The Engine Host storage resolves its worker beside the module that loads it.
await cp(join(daemonDist, "storage.worker.mjs"), join(drill, "storage.worker.mjs"));

const runtime = option("--node") ?? createRequire(import.meta.url)("electron");
const resultFile = join(out, "result.txt");
console.log(`drill on ${process.platform}/${process.arch} with ${runtime}\n  output ${out}`);
const child = spawn(runtime, [join(drill, "drill.mjs"), programs, codex, state, resultFile], {
  cwd: out,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "" },
  stdio: "inherit",
  windowsHide: true,
});
const timer = setTimeout(() => child.kill(), 8 * 60_000);
const [exitCode, exitSignal] = await new Promise((done) => child.once("exit", (code, signal) => done([code, signal])));
const code = exitCode ?? (exitSignal ? 1 : 0);
clearTimeout(timer);
const result = await readFile(resultFile, "utf8").catch(() => "(no result file)\n");
process.stdout.write(result);
console.log(`drill process exited with ${exitSignal ?? exitCode}`);
process.exit(code === 0 && result.trimEnd().split("\n").at(-1) === "PASS" ? 0 : 1);
