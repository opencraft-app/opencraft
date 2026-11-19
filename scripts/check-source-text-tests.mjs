#!/usr/bin/env node
// A test that reads product source text and regex-matches it asserts the
// code's current spelling, not its behavior, so harmless refactors break it.
// New tests exercise behavior. A test that must check source (a static design
// contract) says why with a `// source-contract: <reason>` comment. Existing
// cases are recorded in config/source-text-test-baseline.json, which may only
// shrink.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = "config/source-text-test-baseline.json";
const sourceReference = /["'`](?:\.\.?\/)+(?:apps|packages|plugins)\/[^"'`\s]+\.(?:[cm]?tsx?|scss|css)["'`]/;
const readsFile = /\breadFile(?:Sync)?\s*\(/;
const regexAssertion = /\bassert\.(?:match|doesNotMatch)\s*\(/;
const declared = /\/\/\s*source-contract:\s*\S/;

export function isSourceTextTest(text) {
  return sourceReference.test(text) && readsFile.test(text) && regexAssertion.test(text);
}

function main() {
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "tests"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => /\.test\.[cm]?[jt]sx?$/.test(file));
  const baseline = new Set(JSON.parse(readFileSync(resolve(root, baselinePath), "utf8")).files);
  const found = new Set();
  const violations = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(resolve(root, file), "utf8");
    } catch {
      continue;
    }
    if (!isSourceTextTest(text)) continue;
    found.add(file);
    if (!baseline.has(file) && !declared.test(text)) {
      violations.push(
        `${file}: asserts on product source text; test behavior instead, or add \`// source-contract: <reason>\``,
      );
    }
  }
  for (const file of baseline) {
    if (!found.has(file)) violations.push(`${file}: no longer reads source text; remove it from ${baselinePath}`);
  }
  if (violations.length) {
    console.error("Source-text test violations:\n" + violations.map((line) => `- ${line}`).join("\n"));
    process.exit(1);
  }
  console.log(`Source-text tests: ${found.size} recorded or declared, no new cases.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
