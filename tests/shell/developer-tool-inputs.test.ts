import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

test("external input tools fail with actionable usage before reading files", () => {
  const env = { ...process.env };
  for (const [script, required] of [["export-hermes-connector-catalog.mjs", "marketplace-directory"]]) {
    const result = spawnSync(process.execPath, [join(root, "scripts", script)], { cwd: tmpdir(), env, encoding: "utf8", timeout: 15_000 });
    assert.equal(result.error, undefined, script);
    assert.equal(result.status, 1, script);
    assert.ok(result.stderr.includes(`Usage: node scripts/${script} <${required}>`), script);
    assert.doesNotMatch(result.stderr, /ENOENT/, script);
  }
});

test("catalog export accepts an external snapshot without a machine-specific checkout", async t => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft marketplace input "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, ".codebuddy-connector"));
  await mkdir(join(directory, "icons"));
  await writeFile(join(directory, ".codebuddy-connector/connectors.json"), JSON.stringify({ connectors: [{ id: "example", name: "Example", type: "mcp" }] }));
  await writeFile(join(directory, "icons/example.svg"), "<svg/>");
  const before = await readFile(join(directory, ".codebuddy-connector/connectors.json"), "utf8");
  const result = spawnSync(process.execPath, [join(root, "scripts/export-hermes-connector-catalog.mjs"), directory], { cwd: tmpdir(), encoding: "utf8", timeout: 15_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"id":"example"/);
  assert.match(result.stdout, /\.\/icons\/example\.svg\?no-inline/);
  assert.equal(await readFile(join(directory, ".codebuddy-connector/connectors.json"), "utf8"), before);
});
