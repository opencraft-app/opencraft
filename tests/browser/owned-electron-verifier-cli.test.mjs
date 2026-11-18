import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const cli = resolve("scripts/verify-owned-electron-artifact.mjs");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

test(
  "browser verifier CLI accepts exact inventory and rejects a changed executable",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "owned-cli-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const distribution = join(root, "distribution"),
      fork = join(root, "fork.json");
    await mkdir(distribution);
    const definition = JSON.stringify({ version: "44.8.0", chromiumVersion: "152.0.7977.167" });
    await writeFile(fork, definition);
    const files = [];
    for (const name of ["electron", "LICENSE", "LICENSES.chromium.html"]) {
      const bytes = Buffer.from("fixture " + name);
      await writeFile(join(distribution, name), bytes);
      files.push({ path: name, sha256: hash(bytes), size: bytes.length });
    }
    await chmod(join(distribution, "electron"), 0o755);
    await writeFile(
      join(distribution, "opencraft-electron-artifact.json"),
      JSON.stringify({
        schemaVersion: 1,
        platform: "linux",
        arch: process.arch,
        forkDefinitionSha256: hash(definition),
        electronVersion: "44.8.0",
        chromiumVersion: "152.0.7977.167",
        nativeCopyProbePassed: true,
        files,
      }),
    );
    assert.equal(run("browser", "linux-x64", distribution, fork).status, 0);
    await writeFile(join(distribution, "electron"), "tampered");
    const invalid = run("browser", "linux-x64", distribution, fork);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /checksum/);
  },
);

test("desktop verifier CLI and target validation fail closed on invalid inputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owned-cli-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.notEqual(run("desktop", "macos-arm64", root, join(root, "missing.json")).status, 0);
  assert.notEqual(run("browser", "macos-arm64", root, join(root, "missing.json")).status, 0);
  assert.notEqual(run("other", "linux-x64", root, join(root, "missing.json")).status, 0);
});

test("desktop verifier CLI verifies inventory and rejects tampered native bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owned-desktop-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const distribution = join(root, "distribution"),
    fork = join(root, "fork.json");
  await mkdir(distribution);
  const definition = JSON.stringify({ version: "44.8.0", chromiumVersion: "152.0.7977.167" });
  await writeFile(fork, definition);
  const bytes = Buffer.from("desktop fixture");
  await writeFile(join(distribution, "electron"), bytes);
  await writeFile(
    join(distribution, "opencraft-electron-desktop-artifact.json"),
    JSON.stringify({
      schemaVersion: 1,
      platform: "linux",
      arch: "x64",
      forkDefinitionSha256: hash(definition),
      electronVersion: "44.8.0",
      chromiumVersion: "152.0.7977.167",
      nativeProbePassed: true,
      executable: "electron",
      executableSha256: hash(bytes),
      files: [{ path: "electron", type: "file", size: bytes.length, sha256: hash(bytes) }],
    }),
  );
  assert.equal(run("desktop", "linux-x64", distribution, fork).status, 0);
  await writeFile(join(distribution, "electron"), "tampered");
  const invalid = run("desktop", "linux-x64", distribution, fork);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /inventory mismatch/);
});
