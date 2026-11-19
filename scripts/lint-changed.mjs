#!/usr/bin/env node
// Lints only source files that a change adds, with config/eslint.changed.config.mjs.
//
//   node scripts/lint-changed.mjs [--fix] [--base <ref>]
import { ESLint } from "eslint";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lintSourceGroups } from "./lint-source-groups.mjs";
import { addedSourceFiles, repositoryRoot } from "./added-source-files.mjs";

const worker = process.argv.includes("--lint-worker");
const added = worker ? JSON.parse(readFileSync(0, "utf8")) : addedSourceFiles();
if (!Array.isArray(added) || added.some(file => typeof file !== "string")) throw new Error("Invalid lint source list");
if (!added.length) {
  console.log("lint: no added source files");
  process.exit(0);
}
const fix = process.argv.includes("--fix");
if (!worker) {
  let failed = false;
  for (const group of lintSourceGroups(added)) {
    const result = spawnSync(process.execPath,
      ["--max-old-space-size=3072", fileURLToPath(import.meta.url), "--lint-worker", ...(fix ? ["--fix"] : [])],
      { cwd: repositoryRoot, input: JSON.stringify(group), stdio: ["pipe", "inherit", "inherit"] });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) failed = true;
  }
  console.log(`lint: checked all ${added.length} added file(s) in workspace-isolated workers`);
  process.exit(failed ? 1 : 0);
}
const eslint = new ESLint({
  cwd: repositoryRoot,
  overrideConfigFile: "config/eslint.changed.config.mjs",
  warnIgnored: false,
  fix,
});
const results = await eslint.lintFiles(added);
if (fix) await ESLint.outputFixes(results);
const problems = results.reduce((sum, result) => sum + result.errorCount + result.warningCount, 0);
const output = (await eslint.loadFormatter("stylish")).format(results);
if (output) console.log(output);
if (problems) {
  console.error(
    `lint: ${problems} problem(s) in added files.${fix ? "" : " `npm run lint:changed -- --fix` fixes some."}`,
  );
  process.exit(1);
}
console.log(`lint: ${added.length} added file(s) clean`);
