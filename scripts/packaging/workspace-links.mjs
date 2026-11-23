#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Workspace directories declared by the root manifest. Only exact paths and a
 * trailing single-level `/*` are understood; anything else fails rather than
 * silently checking fewer packages. */
export function workspacePackages(root = repositoryRoot) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces?.packages ?? []);
  const packages = [];
  for (const pattern of patterns) {
    if (
      typeof pattern !== "string" ||
      pattern.startsWith("!") ||
      pattern.slice(0, -2).includes("*") ||
      (pattern.includes("*") && !pattern.endsWith("/*"))
    )
      throw new Error(`Unsupported workspace pattern: ${JSON.stringify(pattern)}`);
    const directories = pattern.endsWith("/*")
      ? readdirSync(join(root, pattern.slice(0, -2)), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(root, pattern.slice(0, -2), entry.name))
      : [join(root, pattern)];
    for (const directory of directories) {
      const file = join(directory, "package.json");
      if (!existsSync(file)) continue;
      const name = JSON.parse(readFileSync(file, "utf8")).name;
      if (typeof name === "string" && name) packages.push({ name, directory });
    }
  }
  return packages;
}

function linkProblem(root, { name, directory }) {
  const link = join(root, "node_modules", ...name.split("/"));
  let entry;
  try {
    entry = lstatSync(link);
  } catch (error) {
    if (error?.code === "ENOENT") return `${name}: not installed`;
    throw error;
  }
  if (!entry.isSymbolicLink()) return `${name}: installed as a copy, not a workspace link`;
  let target;
  try {
    target = realpathSync(link);
  } catch (error) {
    if (error?.code === "ENOENT") return `${name}: link target does not exist`;
    throw error;
  }
  return target === realpathSync(directory) ? null : `${name}: links to ${target}, not ${directory}`;
}

/** A bundler follows `node_modules/<workspace>` wherever it points. When the
 * install came from another checkout (a shared or copied `node_modules`), a
 * build here would silently package that checkout's sources. Packaging entry
 * points call this first so every workspace package resolves into `root`.
 * Third-party dependencies are not checked. Returns the verified names. */
export function verifyWorkspaceLinks(root = repositoryRoot) {
  const realRoot = realpathSync(root);
  const packages = workspacePackages(realRoot);
  const problems = packages.map((entry) => linkProblem(realRoot, entry)).filter(Boolean);
  if (problems.length)
    throw new Error(
      `Workspace packages do not resolve into ${realRoot}; run npm ci in this checkout before packaging.\n  ${problems.join("\n  ")}`,
    );
  return packages.map((entry) => entry.name);
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url))
) {
  try {
    console.log(`${verifyWorkspaceLinks(process.argv[2] ?? repositoryRoot).length} workspace links verified`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
