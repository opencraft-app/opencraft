#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// OpenCraft ships one product version. Every place a user or a store sees it
// carries the same value, and a release tag names it: vX.Y.Z or vX.Y.Z-beta.N.
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const tagPattern = /^v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(?:-beta\.([1-9][0-9]*))?$/u;

const sources = [
  { file: "package.json", path: ["version"] },
  { file: "package-lock.json", path: ["version"] },
  { file: "package-lock.json", path: ["packages", "", "version"] },
  { file: "apps/desktop/package.json", path: ["version"] },
  { file: "package-lock.json", path: ["packages", "apps/desktop", "version"] },
  { file: "apps/mobile/package.json", path: ["version"] },
  { file: "package-lock.json", path: ["packages", "apps/mobile", "version"] },
  { file: "apps/mobile/app.json", path: ["expo", "version"] },
  { file: "deploy/web-server/package.json", path: ["version"] },
];

// The server storage bundle records the product version it was generated for
// (scripts/storage/compile-storage-migrations.mjs reads the root package.json).
// `set` writes the same line `npm run generate:storage` would, and
// `npm run check:storage` compares the whole file with a fresh generation.
const generated = {
  file: "packages/storage-node/src/server/migrations.generated.ts",
  pattern: /^export const OPENCRAFT_VERSION = "([^"]*)" as const;$/mu,
};

export function parseReleaseTag(tag) {
  const match = tagPattern.exec(tag ?? "");
  if (!match) throw new Error(`Release tags are vX.Y.Z or vX.Y.Z-beta.N: ${tag}`);
  return { version: match[1], prerelease: match[2] !== undefined };
}

function locate(document, path) {
  let parent = document;
  for (const key of path.slice(0, -1)) {
    parent = parent?.[key];
    if (parent === null || typeof parent !== "object") return undefined;
  }
  return parent;
}

export function readProductVersions(root) {
  const versions = sources.map(({ file, path }) => {
    const value = locate(JSON.parse(readFileSync(join(root, file), "utf8")), path)?.[path.at(-1)];
    return { source: `${file}:${path.map((key) => key || '""').join(".")}`, version: value };
  });
  const bundle = readFileSync(join(root, generated.file), "utf8").match(generated.pattern);
  return [...versions, { source: `${generated.file}:OPENCRAFT_VERSION`, version: bundle?.[1] }];
}

export function productVersion(root) {
  const versions = readProductVersions(root);
  const distinct = new Set(versions.map(({ version }) => version));
  if (distinct.size !== 1 || !versionPattern.test(versions[0].version ?? "")) {
    const listing = versions.map(({ source, version }) => `  ${source} = ${version}`).join("\n");
    throw new Error(`The product version must be one X.Y.Z everywhere:\n${listing}`);
  }
  return versions[0].version;
}

export function setProductVersion(root, version) {
  if (!versionPattern.test(version ?? "")) throw new Error(`Product versions are X.Y.Z: ${version}`);
  const documents = new Map();
  for (const { file, path } of sources) {
    if (!documents.has(file)) documents.set(file, JSON.parse(readFileSync(join(root, file), "utf8")));
    const parent = locate(documents.get(file), path);
    if (!parent || !(path.at(-1) in parent)) throw new Error(`Missing version field ${file}:${path.join(".")}`);
    parent[path.at(-1)] = version;
  }
  for (const [file, document] of documents) writeFileSync(join(root, file), `${JSON.stringify(document, null, 2)}\n`);
  const bundle = readFileSync(join(root, generated.file), "utf8");
  if (!generated.pattern.test(bundle)) throw new Error(`Missing OPENCRAFT_VERSION in ${generated.file}`);
  writeFileSync(
    join(root, generated.file),
    bundle.replace(generated.pattern, `export const OPENCRAFT_VERSION = ${JSON.stringify(version)} as const;`),
  );
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const [command, argument] = process.argv.slice(2);
  if (command === "check") {
    const version = productVersion(root);
    if (argument !== undefined) {
      const tag = parseReleaseTag(argument);
      if (tag.version !== version) throw new Error(`${argument} does not name the product version ${version}`);
    }
    process.stdout.write(`${version}\n`);
  } else if (command === "set") {
    setProductVersion(root, argument);
    process.stdout.write(`${productVersion(root)}\n`);
  } else {
    throw new Error("Usage: product-version.mjs check [vX.Y.Z | vX.Y.Z-beta.N] | set X.Y.Z");
  }
}
