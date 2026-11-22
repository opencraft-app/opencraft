#!/usr/bin/env node
// Formats only source files that a change adds.
//
//   node scripts/check/format-changed.mjs [--check] [--base <ref>]
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { addedSourceFiles, repositoryRoot } from "./added-source-files.mjs";

const check = process.argv.includes("--check");
const added = addedSourceFiles();
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
