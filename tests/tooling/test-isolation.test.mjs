import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { FILE_BUDGET, MARKER, RUN, fileBudgetMs } from "../support/test-isolation.mjs";

const preload = new URL("../support/test-isolation.mjs", import.meta.url).pathname;

/** Runs one fixture file under the CI isolation preload with the given budget. */
function runIsolated(source, budget) {
  const dir = mkdtempSync(join(tmpdir(), "opencraft-isolation-budget-"));
  try {
    const file = join(dir, "fixture.test.mjs");
    writeFileSync(file, source);
    const env = { ...process.env, NODE_OPTIONS: `--import ${preload}`, [FILE_BUDGET]: String(budget) };
    // An outer isolated run would make the fixture inherit its isolation and skip the watchdog.
    delete env[MARKER];
    delete env[RUN];
    delete env.NODE_TEST_CONTEXT;
    const started = Date.now();
    const result = spawnSync(process.execPath, ["--test", file], { env, encoding: "utf8", timeout: 60_000 });
    return { ...result, elapsed: Date.now() - started, output: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a test that never settles fails at the file budget and names the file", () => {
  const result = runIsolated(
    "import test from 'node:test';\ntest('hangs', () => new Promise(() => { setInterval(() => {}, 1000); }));\n",
    1_000,
  );
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /\[test-isolation\] \S*fixture\.test\.mjs did not exit within 1s/);
  assert.ok(result.elapsed < 30_000, `took ${result.elapsed}ms`);
});

test("a handle left open after the last test fails the file and is reported", () => {
  const result = runIsolated(
    "import test from 'node:test';\nimport { createServer } from 'node:net';\ntest('leaves a server', () => { createServer().listen(0, '127.0.0.1'); });\n",
    1_000,
  );
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /still active: [^\n]*TCPServerWrap/);
});

test("a file that finishes in time is not held by the watchdog", () => {
  const result = runIsolated("import test from 'node:test';\ntest('quick', () => {});\n", 30_000);
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /\[test-isolation\]/);
  assert.ok(result.elapsed < 20_000, `took ${result.elapsed}ms`);
});

test("the file budget defaults to five minutes, accepts 0 to disable and rejects malformed values", () => {
  assert.equal(fileBudgetMs(undefined), 300_000);
  assert.equal(fileBudgetMs(""), 300_000);
  assert.equal(fileBudgetMs("0"), 0);
  assert.equal(fileBudgetMs("1500"), 1_500);
  for (const value of ["-1", "1e3", "5m", " 10"]) assert.throws(() => fileBudgetMs(value), /whole number/);
});
