#!/usr/bin/env node
// Formats only source files that a change adds. Existing files keep their
// current layout so a small edit never turns into a whole-file reformat.
//
//   node scripts/format-changed.mjs [--check] [--base <ref>]
//
// --base defaults to the merge-base with origin/main. CI passes the pull
// request merge commit's first parent.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const formattable = /\.(?:[cm]?[jt]sx?)$/u;
const excluded = /^(?:vendor|dist|release|runtime\/dsh\/node_modules)\/|\/(?:dist|node_modules|generated)\/|_generated\./u;

const args = process.argv.slice(2);
const check = args.includes("--check");
const baseIndex = args.indexOf("--base");
const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: repositoryRoot, encoding: "utf8" }).trim();
const base = baseIndex >= 0 ? args[baseIndex + 1] : git("merge-base", "origin/main", "HEAD");
if (!base) throw new Error("--base requires a Git ref");

// The working tree, including untracked files, so new files are covered before they are committed.
const candidates = [
  ...git("diff", "--name-only", "--diff-filter=A", "-z", base).split("\0"),
  ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0"),
];
const added = [...new Set(candidates)]
  .filter((file) => file && formattable.test(file) && !excluded.test(file) && existsSync(resolve(repositoryRoot, file)));

if (!added.length) {
  console.log("format: no added source files");
  process.exit(0);
}
const prettier = createRequire(import.meta.url).resolve("prettier/bin/prettier.cjs");
const result = spawnSync(process.execPath, [prettier, check ? "--check" : "--write", "--", ...added], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
if (result.status !== 0 && check) {
  console.error("Run `npm run format:changed` to format the added files.");
}
process.exit(result.status ?? 1);
