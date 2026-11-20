import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// npm can drop the other platforms' optional native bindings when it rewrites
// the lockfile on one platform (npm/cli#4828). `npm ci` on macOS or Windows then
// installs no binding at all, and tools such as rolldown fail at runtime.
const DESKTOP_PLATFORMS = ["darwin", "win32"];

test("every locked platform-specific optional dependency is present for macOS and Windows", () => {
  const { packages } = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
  const locate = (from, name) => {
    for (let base = from; ; ) {
      const key = `${base ? `${base}/` : ""}node_modules/${name}`;
      if (key in packages) return key;
      if (!base) return null;
      const index = base.lastIndexOf("/node_modules/");
      base = index < 0 ? "" : base.slice(0, index);
    }
  };
  const missing = [];
  for (const [path, entry] of Object.entries(packages)) {
    for (const name of Object.keys(entry.optionalDependencies ?? {})) {
      if (!DESKTOP_PLATFORMS.some((platform) => name.includes(`-${platform}-`))) continue;
      if (!locate(path, name)) missing.push(`${path || "(root)"} -> ${name}`);
    }
  }
  assert.deepEqual(missing, [], "Restore the missing entries (for example npm install --package-lock-only from a lockfile that has them)");
});
