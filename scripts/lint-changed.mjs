#!/usr/bin/env node
// Lints only source files that a change adds, with config/eslint.changed.config.mjs.
//
//   node scripts/lint-changed.mjs [--fix] [--base <ref>]
import { ESLint } from "eslint";
import { addedSourceFiles, repositoryRoot } from "./added-source-files.mjs";

const added = addedSourceFiles();
if (!added.length) {
  console.log("lint: no added source files");
  process.exit(0);
}
const fix = process.argv.includes("--fix");
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
