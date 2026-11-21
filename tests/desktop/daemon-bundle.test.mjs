import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { daemonMainBundle, packagedDaemonExternals } from "../../apps/opencraft-daemon/main-bundle.mjs";

const daemonDirectory = fileURLToPath(new URL("../../apps/opencraft-daemon/", import.meta.url));
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));

// A packaged desktop starts this bundle with only node-pty beside it. An
// external that loads at startup (instead of when its feature runs) stops the
// daemon before it listens, and the app can never connect to its local host.
test("the desktop daemon loads only built-ins and shipped modules at startup", async t => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-daemon-bundle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, "main.cjs");
  const result = await build({ ...daemonMainBundle, absWorkingDir: daemonDirectory, outfile, metafile: true, logLevel: "silent" });
  const source = await readFile(outfile, "utf8");
  // esbuild hoists eager imports to column zero; lazily initialised modules
  // and dynamic imports keep their requires indented inside a function.
  const eager = [...source.matchAll(/^var [\w$]+ = (?:__toESM\()?require\("([^"]+)"\)/gm)].map(match => match[1]);
  const unexpected = [...new Set(eager)].filter(name => !builtins.has(name) && !packagedDaemonExternals.has(name));
  assert.deepEqual(unexpected, [], "move these imports behind the feature that needs them");
  const bundledEsbuild = Object.keys(result.metafile.inputs).filter(file => file.includes("node_modules/esbuild/"));
  assert.deepEqual(bundledEsbuild, [], "the esbuild JavaScript API cannot run from a bundle");
});
