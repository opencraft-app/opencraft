import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Supplement the existing root suites without replacing or suppressing them.
// All entries are reviewed repository-local tests; optional native tests keep
// their own explicit capability/fixture requirements and report actual skips.
const root = fileURLToPath(new URL("../", import.meta.url));
const tests = JSON.parse(readFileSync(new URL("./convergence-test-files.json", import.meta.url), "utf8"));
if (!Array.isArray(tests) || !tests.length || new Set(tests).size !== tests.length
  || tests.some(path => typeof path !== "string" || path.startsWith("/") || path.split("/").includes("..") || !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)))
  throw new Error("Invalid convergence regression manifest");
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=2", ...tests], { cwd: root, env: process.env, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
