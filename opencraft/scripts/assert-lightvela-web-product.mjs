#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const outputRoot = resolve(repositoryRoot, "apps/workbench-web/dist-lightvela-web");
const manifestPath = resolve(outputRoot, ".vite/manifest.json");
const forbidden = [
  "plugins/hypernode",
  "plugin-hypernode",
  "createHyperNodeExtension",
  "vela.hypernode",
];

async function executableFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await executableFiles(path));
    else if (entry.name.endsWith(".js")) result.push(path);
  }
  return result;
}

const manifest = await readFile(manifestPath, "utf8");
if (!manifest.includes("plugins/lightvela-hermes")) {
  throw new Error("LightVela Web bundle does not contain the LightVela/Hermes plugin");
}

const inspected = [manifestPath, ...await executableFiles(outputRoot)];
for (const path of inspected) {
  const source = path === manifestPath ? manifest : await readFile(path, "utf8");
  const match = forbidden.find((token) => source.includes(token));
  if (match !== undefined) {
    throw new Error(`LightVela Web bundle contains forbidden HyperNode token ${match} in ${path}`);
  }
}

process.stdout.write(`LightVela Web plugin boundary passed (${inspected.length} executable artifacts).\n`);
