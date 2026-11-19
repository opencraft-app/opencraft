import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
let count = 0;
const modules = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? modules(join(directory, entry.name))
      : entry.name.endsWith(".mjs")
        ? [join(directory, entry.name)]
        : [],
  );
for (const directory of ["src", "bin", "test", "scripts"]) {
  for (const file of modules(join(root, directory))) {
    const run = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
    });
    if (run.status !== 0) {
      console.error(run.stderr);
      process.exit(run.status ?? 1);
    }
    count++;
  }
}
console.log(
  `Syntax checked ${count} modules. This is not a TypeScript typecheck.`,
);
