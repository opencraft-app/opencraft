#!/usr/bin/env node
import { selectWorkspaceManifests } from "./workspace-typecheck-plan.mjs";
// Runs every workspace's `typecheck` script in parallel. Each is an
// independent `tsc --noEmit`, so order does not matter; running them one at a
// time left all but one core idle.
//
// Concurrency defaults to the CPU count, capped so each tsc has about 2 GiB of
// memory. OPENCRAFT_TYPECHECK_CONCURRENCY overrides it. Output is buffered per
// workspace and printed in full only for failures.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const patterns = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces;
const trackedManifests = execFileSync("git", ["ls-files", "--", "**/package.json"], { cwd: root, encoding: "utf8" }).split("\n");
const workspaces = selectWorkspaceManifests(patterns, trackedManifests)
  .map((file) => ({ dir: dirname(file), manifest: JSON.parse(readFileSync(join(root, file), "utf8")) }))
  .filter(({ manifest }) => typeof manifest.scripts?.typecheck === "string");

// Start the largest projects first so a big one never runs alone at the end.
const sourceCounts = new Map();
for (const file of execFileSync("git", ["ls-files", "--", "*.ts", "*.tsx", "*.mts"], {
  cwd: root,
  encoding: "utf8",
}).split("\n")) {
  const dir = file.split("/").slice(0, 2).join("/");
  sourceCounts.set(dir, (sourceCounts.get(dir) ?? 0) + 1);
}
workspaces.sort((a, b) => (sourceCounts.get(b.dir) ?? 0) - (sourceCounts.get(a.dir) ?? 0));

const requested = Number(process.env.OPENCRAFT_TYPECHECK_CONCURRENCY);
const concurrency =
  Number.isSafeInteger(requested) && requested > 0
    ? requested
    : Math.max(1, Math.min(availableParallelism(), Math.floor(totalmem() / 2 ** 31)));

function typecheck({ dir, manifest }) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(npm, ["run", "typecheck", "--silent"], {
      cwd: join(root, dir),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    child.on("error", (error) => output.push(Buffer.from(String(error))));
    child.on("close", (code) =>
      done({
        name: manifest.name ?? dir,
        code,
        seconds: (Date.now() - started) / 1000,
        output: Buffer.concat(output).toString(),
      }),
    );
  });
}

const started = Date.now();
const queue = [...workspaces];
const results = [];
await Promise.all(
  Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) results.push(await typecheck(next));
  }),
);

const failed = results.filter((result) => result.code !== 0);
for (const result of failed) process.stderr.write(`\n✖ ${result.name}\n${result.output.trim()}\n`);
const slowest = [...results]
  .sort((a, b) => b.seconds - a.seconds)
  .slice(0, 3)
  .map((result) => `${result.name} ${result.seconds.toFixed(0)}s`)
  .join(", ");
console.log(
  `typecheck: ${results.length - failed.length}/${results.length} workspaces passed in ${((Date.now() - started) / 1000).toFixed(0)}s ` +
    `(concurrency ${concurrency}; slowest: ${slowest})`,
);
if (!existsSync(join(root, "node_modules"))) console.error("typecheck: node_modules is missing; run npm ci first");
process.exit(failed.length ? 1 : 0);
