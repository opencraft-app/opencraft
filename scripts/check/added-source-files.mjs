// Source files a change adds, shared by `format:changed` and `lint:changed`.
// Existing files are left alone so a small edit never turns into a rewrite.
//
//   --base <ref>  compare against this commit; defaults to the merge-base
//                 with origin/main. CI passes the pull request merge
//                 commit's first parent.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = /\.(?:[cm]?[jt]sx?)$/u;
const excluded =
  /^(?:vendor|dist|release|runtime\/dsh\/node_modules)\/|\/(?:dist|node_modules|generated)\/|_generated\./u;

export function addedSourceFiles(args = process.argv.slice(2)) {
  const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const baseIndex = args.indexOf("--base");
  const base = baseIndex >= 0 ? args[baseIndex + 1] : git("merge-base", "origin/main", "HEAD");
  if (!base) throw new Error("--base requires a Git ref");
  // The working tree, including untracked files, so new files are covered before they are committed.
  const candidates = [
    ...git("diff", "--name-only", "--diff-filter=A", "-z", base).split("\0"),
    ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0"),
  ];
  return [...new Set(candidates)].filter(
    (file) => file && source.test(file) && !excluded.test(file) && existsSync(resolve(repositoryRoot, file)),
  );
}
