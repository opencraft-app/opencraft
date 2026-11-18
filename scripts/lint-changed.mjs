#!/usr/bin/env node
// Lints only source files that a change adds, with config/eslint.changed.config.mjs.
//
//   node scripts/lint-changed.mjs [--fix] [--base <ref>]
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { addedSourceFiles, repositoryRoot } from "./added-source-files.mjs";

const added = addedSourceFiles();
if (!added.length) {
  console.log("lint: no added source files");
  process.exit(0);
}
const eslint = createRequire(import.meta.url).resolve("eslint/bin/eslint.js");
const result = spawnSync(
  process.execPath,
  [
    eslint,
    "--config",
    "config/eslint.changed.config.mjs",
    "--no-warn-ignored",
    "--max-warnings=0",
    ...(process.argv.includes("--fix") ? ["--fix"] : []),
    "--",
    ...added,
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);
process.exit(result.status ?? 1);
