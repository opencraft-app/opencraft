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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baselinePath = "config/source-text-test-baseline.json";
const sourceReference = /["'`](?:\.\.?\/)+(?:apps|packages|plugins)\/[^"'`\s]+\.(?:[cm]?tsx?|scss|css)["'`]/;
const readsFile = /\breadFile(?:Sync)?\s*\(/;
const regexAssertion = /\bassert\.(?:match|doesNotMatch)\s*\(/;
const declared = /\/\/\s*source-contract:\s*\S/;

// Inside a read call a root-relative path ("apps/...") also names product source.
const sourceArgument = /["'`](?:\.\.?\/)*(?:apps|packages|plugins)\/[^"'`\s]+\.(?:[cm]?tsx?|scss|css)["'`]/;
const sourceReferenceGlobal = new RegExp(sourceArgument.source, "g");
const binding = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*(?:\n(?!\s*(?:const|let|var)\b)[^;\n]*){0,3})/g;

/** Names of local helpers that wrap readFile, such as `const read = (path) => readFileSync(...)`. */
function readerNames(text) {
  const names = ["readFile", "readFileSync"];
  for (const [, name] of text.matchAll(
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>[^;\n]*\breadFile(?:Sync)?\s*\(/g,
  ))
    names.push(name);
  for (const [, name] of text.matchAll(
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)[^{]*\{[^}]*\breadFile(?:Sync)?\s*\(/g,
  ))
    names.push(name);
  return names;
}

/** Arguments of each read call (readFile, readFileSync or a local wrapper), up to its balanced closing parenthesis. */
function readFileArguments(text) {
  const result = [];
  const call = new RegExp(`(?<![\\w$.])(?:${readerNames(text).join("|")})\\s*\\(`, "g");
  for (const match of text.matchAll(call)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < text.length && depth > 0) {
      if (text[index] === "(") depth++;
      else if (text[index] === ")") depth--;
      index++;
    }
    result.push(text.slice(start, index - 1));
  }
  return result;
}

/**
 * True when the file reads product source (a readFile argument names an
 * apps/packages/plugins source file, directly or through a binding that does)
 * and asserts on text with a regex. Tests that only mention source paths to
 * start a process and read runtime output are not source-text tests.
 */
export function isSourceTextTest(text) {
  if (!sourceReference.test(text) || !readsFile.test(text) || !regexAssertion.test(text)) return false;
  const sourceBindings = new Set();
  for (const [, name, value] of text.matchAll(binding)) {
    if (
      sourceReferenceGlobal.test(value) ||
      [...sourceBindings].some((known) => new RegExp(`\\b${known}\\b`).test(value))
    )
      sourceBindings.add(name);
    sourceReferenceGlobal.lastIndex = 0;
  }
  return readFileArguments(text).some(
    (argument) =>
      sourceArgument.test(argument) || [...sourceBindings].some((name) => new RegExp(`\\b${name}\\b`).test(argument)),
  );
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
