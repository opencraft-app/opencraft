import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { checkBrowserCompatibility } from "./browser-compatibility-checker.mjs";

const started = performance.now();
const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.length > 3) throw new Error("Usage: check-browser-compatibility.mjs [module-graph.json]");
const graph = process.argv[2] ? path.resolve(process.argv[2]) : new URL("../node_modules/.cache/opencraft/browser-modules.json", import.meta.url);
const files = JSON.parse(readFileSync(graph, "utf8"));
const { results, output } = await checkBrowserCompatibility(root, files);
if (output) process.stdout.write(output);
const errors = results.reduce((sum, result) => sum + result.errorCount + result.warningCount, 0);
console.log(`Browser compatibility: ${files.length} runtime source files, ${errors} issues, ${((performance.now() - started) / 1000).toFixed(1)}s.`);
if (errors) process.exitCode = 1;
