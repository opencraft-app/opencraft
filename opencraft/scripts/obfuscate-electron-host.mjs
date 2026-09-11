#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import JavaScriptObfuscator from "javascript-obfuscator";

const target = process.argv[2];
if (target !== "browser" && target !== "node") {
  throw new Error("First argument must be the JavaScript target: browser or node");
}
const files = process.argv.slice(3);
if (files.length === 0) {
  throw new Error("Pass at least one Electron host JavaScript file to obfuscate");
}

const options = {
  ...JavaScriptObfuscator.getOptionsByPreset("high-obfuscation"),
  debugProtection: false,
  debugProtectionInterval: 0,
  disableConsoleOutput: false,
  deadCodeInjectionThreshold: 0.7,
  ignoreImports: true,
  seed: 748291,
  sourceMap: false,
  target,
};

for (const file of files) {
  const absolutePath = resolve(file);
  const source = await readFile(absolutePath, "utf8");
  const obfuscated = JavaScriptObfuscator.obfuscate(source, options).getObfuscatedCode();
  await writeFile(absolutePath, `${obfuscated}\n`, "utf8");
  process.stdout.write(`obfuscated ${absolutePath}\n`);
}
