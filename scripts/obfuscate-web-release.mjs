#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import JavaScriptObfuscator from "javascript-obfuscator";

const outputRoot = resolve(process.argv[2] ?? "");
if (process.argv[2] === undefined) throw new Error("Pass a Vite output directory");

const manifestPath = join(outputRoot, ".vite", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const ownedFiles = new Set(
  Object.entries(manifest)
    .filter(([source]) => source === "index.html"
      || source.startsWith("src/")
      || source.startsWith("../../packages/")
      || source.startsWith("../../plugins/"))
    .map(([, entry]) => entry.file)
    .filter((file) => typeof file === "string" && file.endsWith(".js")),
);

async function listFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path));
    else result.push(path);
  }
  return result;
}

async function unlinkIfPresent(path) {
  try {
    await unlink(path);
  } catch (error) {
    // Multiple manifest entries can canonicalize to the same emitted chunk.
    // Cleanup is a set operation: once that old name is absent, the invariant
    // is already satisfied and a second removal must remain idempotent.
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

const deepOptions = {
  ...JavaScriptObfuscator.getOptionsByPreset("high-obfuscation"),
  debugProtection: false,
  debugProtectionInterval: 0,
  // Production diagnostics are an explicit runtime contract. Removing the
  // calls makes a remote Host connection impossible to stage-profile.
  disableConsoleOutput: false,
  deadCodeInjectionThreshold: 1,
  ignoreImports: true,
  renameGlobals: true,
  // Property names are an ABI boundary: AppServer frames, DOM props and
  // extension contracts share the same syntax as private object fields.
  // Post-bundle property mangling cannot distinguish them soundly.
  renameProperties: false,
  seed: 748291,
  sourceMap: false,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 1,
  target: "browser",
};

// Applying control-flow flattening and dead-code injection to an already
// minified application entry has pathological growth (a 1.3 MB chunk became
// 66 MB). Large chunks have already passed Oxc top-level mangling, so keep the
// extra release pass focused on identifier/string concealment. Deep transforms
// remain useful on the small first-party glue modules where their cost is
// bounded.
const LARGE_CHUNK_BYTES = 64_000;
const optionsFor = (source) => source.length > LARGE_CHUNK_BYTES
  ? {
      ...JavaScriptObfuscator.getOptionsByPreset("low-obfuscation"),
      compact: true,
      debugProtection: false,
      debugProtectionInterval: 0,
      disableConsoleOutput: false,
      ignoreImports: true,
      renameGlobals: true,
      renameProperties: false,
      seed: 748291,
      selfDefending: false,
      sourceMap: false,
      splitStrings: false,
      stringArray: true,
      stringArrayEncoding: ["base64"],
      stringArrayThreshold: 0.72,
      target: "browser",
    }
  : deepOptions;

const allFiles = await listFiles(outputRoot);
const contents = new Map();
for (const path of allFiles) {
  const extension = path.endsWith(".js") ? "js" : path.endsWith(".html") || path === manifestPath ? "text" : null;
  if (extension !== null) contents.set(path, await readFile(path, "utf8"));
}

// Establish the complete filename graph before transforming source. Vite's
// module preload table stores lazy chunk URLs as ordinary string literals;
// once an obfuscator moves those strings into an encoded array they can no
// longer be rewritten soundly. The Vite filename is already content-derived,
// so hashing the original emitted source preserves cache busting while making
// the second-stage name available before obfuscation.
const renamed = new Map();
for (const relativeFile of ownedFiles) {
  const path = join(outputRoot, ...relativeFile.split("/"));
  const source = contents.get(path);
  if (source === undefined) throw new Error(`Manifest-owned chunk is missing: ${relativeFile}`);
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 12);
  renamed.set(path, join(dirname(path), `a-${digest}.js`));
}

const replacements = [...renamed].map(([from, to]) => [
  relative(outputRoot, from).split(sep).join("/"),
  relative(outputRoot, to).split(sep).join("/"),
]);
const rewriteReferences = (source) => replacements.reduce((value, [from, to]) => (
  value.replaceAll(from, to).replaceAll(basename(from), basename(to))
), source);

for (const relativeFile of ownedFiles) {
  const path = join(outputRoot, ...relativeFile.split("/"));
  const source = contents.get(path);
  if (source === undefined) throw new Error(`Manifest-owned chunk is missing: ${relativeFile}`);
  const rewrittenSource = rewriteReferences(source);
  const filePrefix = createHash("sha256").update(relativeFile).digest("hex").slice(0, 8);
  const obfuscated = JavaScriptObfuscator.obfuscate(rewrittenSource, {
    ...optionsFor(rewrittenSource),
    identifiersPrefix: `_${filePrefix}`,
  }).getObfuscatedCode();
  contents.set(path, `${obfuscated}\n`);
}

function sanitizedManifest() {
  const keyMap = new Map(Object.keys(manifest).map((key) => [
    key,
    `m-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`,
  ]));
  const output = {};
  for (const [key, rawEntry] of Object.entries(manifest)) {
    const entry = structuredClone(rawEntry);
    entry.file = rewriteReferences(entry.file);
    if (Array.isArray(entry.css)) entry.css = entry.css.map(rewriteReferences);
    if (Array.isArray(entry.assets)) entry.assets = entry.assets.map(rewriteReferences);
    if (Array.isArray(entry.imports)) entry.imports = entry.imports.map((item) => keyMap.get(item) ?? item);
    if (Array.isArray(entry.dynamicImports)) {
      entry.dynamicImports = entry.dynamicImports.map((item) => keyMap.get(item) ?? item);
    }
    delete entry.name;
    delete entry.src;
    output[keyMap.get(key)] = entry;
  }
  return `${JSON.stringify(output)}\n`;
}

for (const [path, source] of contents) {
  const output = path === manifestPath ? sanitizedManifest() : rewriteReferences(source);
  const destination = renamed.get(path) ?? path;
  await writeFile(destination, output, "utf8");
}
// Generated output is disposable. Remove the old names only after every new
// chunk and every reference has been committed.
const destinations = new Set(renamed.values());
for (const [from, to] of renamed) {
  if (from !== to && !destinations.has(from)) await unlinkIfPresent(from);
}

const remainingFiles = await listFiles(outputRoot);
for (const path of remainingFiles) {
  const relativePath = relative(outputRoot, path).split(sep).join("/");
  if (relativePath.endsWith(".map")) {
    await unlinkIfPresent(path);
    continue;
  }
  if (relativePath.startsWith("assets/") && /\.(?:js|css)$/u.test(relativePath)
    && !/^assets\/a-[a-zA-Z0-9_-]{8,}\.(?:js|css)$/u.test(relativePath)) {
    throw new Error(`Hardened release contains a semantic executable asset name: ${relativePath}`);
  }
}

const publicManifest = await readFile(manifestPath, "utf8");
if (/(?:\.\.\/|src\/|packages\/|plugins\/)/u.test(publicManifest)) {
  throw new Error("Hardened manifest still exposes a source topology");
}

process.stdout.write(`obfuscated ${renamed.size} first-party chunks in ${outputRoot}\n`);
