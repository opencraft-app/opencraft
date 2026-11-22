import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

function workspacePackages() {
  const packages = [];
  for (const group of ["apps", "packages", "plugins"]) {
    for (const entry of readdirSync(path.join(root, group), { withFileTypes: true })) {
      const manifest = path.join(root, group, entry.name, "package.json");
      if (entry.isDirectory() && existsSync(manifest)) {
        packages.push({ directory: path.join(group, entry.name), manifest: JSON.parse(readFileSync(manifest, "utf8")) });
      }
    }
  }
  return packages;
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (value && typeof value === "object") return Object.values(value).flatMap(exportTargets);
  return [];
}

// Downstream products compose core through declared subpath exports instead of
// reaching into src/. A stale entry would only fail in a downstream build, so
// every source export must keep pointing at a committed file.
test("workspace package source exports point at committed files", () => {
  const missing = [];
  for (const { directory, manifest } of workspacePackages()) {
    const exports = manifest.exports;
    if (!exports || typeof exports !== "object") continue;
    for (const [subpath, value] of Object.entries(exports)) {
      for (const target of exportTargets(value)) {
        // Wildcards and build outputs are validated by their own builds.
        if (target.includes("*") || target.startsWith("./dist/")) continue;
        if (!existsSync(path.join(root, directory, target))) missing.push(`${manifest.name} ${subpath} -> ${target}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
