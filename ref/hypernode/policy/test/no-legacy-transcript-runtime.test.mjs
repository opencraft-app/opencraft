import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import test from "node:test";

const runtimeRoot = resolve("policy/src");
const runtimeFiles = [
  ...javascriptFiles(runtimeRoot),
  resolve("scripts/dsh-engine-worker.mjs"),
];

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return extname(entry.name) === ".js" ? [path] : [];
  });
}

const forbiddenRuntimeTranscriptSymbols = [
  "do_thread_catalog_turns",
  "hypernode_dsh_native_events",
  "completedDshHistory",
  "legacyDshMigrationHistory",
  "portableResponseHistory",
  "migrationHistory",
  "resumeSnapshot",
  "assertContiguousDshEvents",
];

test("runtime contains no legacy transcript compatibility branch", () => {
  const violations = [];
  for (const file of runtimeFiles) {
    const source = readFileSync(file, "utf8");
    for (const symbol of forbiddenRuntimeTranscriptSymbols) {
      if (source.includes(symbol)) {
        violations.push(`${relative(resolve("."), file)}: ${symbol}`);
      }
    }
  }

  assert.deepEqual(violations, [], [
    "legacy transcript knowledge belongs only in an offline one-time migration script",
    ...violations,
  ].join("\n"));
});
