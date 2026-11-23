// Bundles start Workers and helper programs from files beside themselves
// (`new URL("./x-worker.mjs", import.meta.url)`, `ownerEntry(import.meta.url, "x")`).
// Each packaging script lists those files by hand, and a missing one only shows
// when the feature runs in production. This check reads every bundle in a
// packaged directory and fails when a sibling it names was not built beside it.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const BUNDLE = /\.(?:mjs|cjs|js)$/u;
// `new URL("./name.mjs", import.meta.url)` and the CommonJS bundle form with `import_meta_url`.
const URL_REFERENCE =
  /new URL\(\s*["'`]\.\/([A-Za-z0-9._-]+\.(?:mjs|cjs|js))["'`]\s*,\s*(?:import\.meta\.url|import_meta_url\d*)\s*\)/gu;
// `ownerEntry(import.meta.url, "name")` resolves to `name-worker.mjs` in a bundle.
const OWNER_ENTRY =
  /\bownerEntry\d*\(\s*(?:import\.meta\.url|import_meta_url\d*)\s*,\s*["'`]([A-Za-z0-9._-]+)["'`]\s*\)/gu;

/** Sibling file names one bundle's source starts by URL. */
export function siblingReferences(source) {
  const names = new Set();
  for (const match of source.matchAll(URL_REFERENCE)) names.add(match[1]);
  for (const match of source.matchAll(OWNER_ENTRY)) names.add(`${match[1]}-worker.mjs`);
  return names;
}

/**
 * Check every bundle directly in `directory` (and in `nested` subdirectories).
 * `optional` maps a sibling name to the reason a bundle may reference it
 * without shipping it (a feature that build leaves out). Returns the missing
 * references as "bundle -> sibling" lines; throws when `strict`.
 */
export async function verifySiblingFiles(directory, { nested = [], optional = {}, strict = true } = {}) {
  const missing = [];
  for (const folder of [directory, ...nested.map((name) => join(directory, name))]) {
    // A nested directory this build does not produce has nothing to check.
    const names = await readdir(folder).catch((error) => {
      if (error.code === "ENOENT" && folder !== directory) return [];
      throw error;
    });
    const present = new Set(names);
    for (const name of names) {
      if (!BUNDLE.test(name)) continue;
      const path = join(folder, name);
      if (!(await stat(path)).isFile()) continue;
      for (const sibling of siblingReferences(await readFile(path, "utf8"))) {
        if (present.has(sibling) || Object.hasOwn(optional, sibling)) continue;
        missing.push(`${relative(directory, path)} -> ${sibling}`);
      }
    }
  }
  if (missing.length && strict)
    throw new Error(
      `Bundles start files that were not built beside them:\n  ${missing.join("\n  ")}\n` +
        "Build each one next to its bundle, or list it as optional with the reason the feature is absent.",
    );
  return missing;
}

/** Files a desktop bundle may name without shipping, with the reason the feature is absent there. */
export const DESKTOP_ABSENT_SIBLINGS = Object.freeze({
  "shell-extension.mjs":
    "the Pi shell worker loads pi-shell-extension.mjs first; this name is its source-tree fallback",
  "pi-shell-worker.mjs":
    "the Pi engine runtime is not shipped with the desktop (#399); its shell loads only with a Pi agent",
  "sandbox-command.mjs": "engine sandboxes are configured only on servers (OPENCRAFT_SANDBOX_CONFIG)",
  "dsh-terminal-agent.mjs": "engine sandboxes are configured only on servers (OPENCRAFT_SANDBOX_CONFIG)",
});

/** Files any bundle may name without shipping: source-tree fallbacks tried only after the packaged name. */
export const SOURCE_FALLBACK_SIBLINGS = Object.freeze({
  "shell-extension.mjs":
    "the Pi shell worker loads pi-shell-extension.mjs first; this name is its source-tree fallback",
});
