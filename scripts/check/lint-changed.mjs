#!/usr/bin/env node
// Lints only source files that a change adds, with config/eslint.changed.config.mjs.
//
//   node scripts/check/lint-changed.mjs [--fix] [--base <ref>]
//
// Typed rules load each file's TypeScript project, and one process keeps every
// project it has loaded. A large change spanning many workspaces then needs
// several GB of heap, so each workspace's files are linted in a process of its own.
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { addedSourceFiles, repositoryRoot } from "./added-source-files.mjs";

const fix = process.argv.includes("--fix");
const GROUP = "OPENCRAFT_LINT_CHANGED_FILES";

/** The workspace a file belongs to (apps/x, packages/x, plugins/x), or its top-level directory. */
function lintGroup(file) {
  const parts = file.split("/");
  if (parts.length === 1) return ".";
  return /^(?:apps|packages|plugins)$/u.test(parts[0]) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

async function lint(files) {
  const eslint = new ESLint({
    cwd: repositoryRoot,
    overrideConfigFile: "config/eslint.changed.config.mjs",
    warnIgnored: false,
    fix,
  });
  const results = await eslint.lintFiles(files);
  if (fix) await ESLint.outputFixes(results);
  return results;
}

function lintInChild(files) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...(fix ? ["--fix"] : [])], {
      cwd: repositoryRoot,
      env: { ...process.env, [GROUP]: JSON.stringify(files) },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) reject(new Error(`lint: ${files[0]} and its workspace failed (${signal ?? code})`));
      else resolve(JSON.parse(output));
    });
  });
}

if (process.env[GROUP]) {
  // A child: lint one workspace's files and report the results to the parent.
  process.stdout.write(JSON.stringify(await lint(JSON.parse(process.env[GROUP]))));
} else {
  const added = addedSourceFiles();
  if (!added.length) {
    console.log("lint: no added source files");
    process.exit(0);
  }
  const groups = new Map();
  for (const file of added) groups.set(lintGroup(file), [...(groups.get(lintGroup(file)) ?? []), file]);
  const pending = [...groups.values()];
  const results = [];
  const worker = async () => {
    for (let files = pending.shift(); files; files = pending.shift()) results.push(...(await lintInChild(files)));
  };
  await Promise.all(
    Array.from({ length: Math.min(pending.length, Math.max(1, availableParallelism() - 1), 4) }, worker),
  );
  results.sort((left, right) => left.filePath.localeCompare(right.filePath));
  const problems = results.reduce((sum, result) => sum + result.errorCount + result.warningCount, 0);
  const output = (await new ESLint({ cwd: repositoryRoot }).loadFormatter("stylish")).format(results);
  if (output) console.log(output);
  if (problems) {
    console.error(
      `lint: ${problems} problem(s) in added files.${fix ? "" : " `npm run lint:changed -- --fix` fixes some."}`,
    );
    process.exit(1);
  }
  console.log(`lint: ${added.length} added file(s) in ${groups.size} workspace(s) clean`);
}
