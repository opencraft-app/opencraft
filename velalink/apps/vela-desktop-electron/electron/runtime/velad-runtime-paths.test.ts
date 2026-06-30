import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bundledVeladPath } from "./velad-runtime-paths";

const binaryName = process.platform === "win32" ? "velad.exe" : "velad";

test("runtime path resolver prefers packaged velad", () => {
  const root = mkdtempSync(join(tmpdir(), "vela-runtime-paths-"));
  try {
    const resourcesPath = join(root, "resources");
    const packaged = join(resourcesPath, "bin", binaryName);
    mkdirSync(join(resourcesPath, "bin"), { recursive: true });
    writeFileSync(packaged, "");

    assert.equal(bundledVeladPath(resourcesPath), packaged);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime path resolver falls back to repo debug velad in dev cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "vela-runtime-paths-"));
  const originalCwd = process.cwd();
  try {
    const appRoot = join(root, "apps", "vela-desktop-electron");
    const devBinary = join(root, "target", "debug", binaryName);
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(join(root, "target", "debug"), { recursive: true });
    writeFileSync(devBinary, "");

    process.chdir(appRoot);

    assert.equal(bundledVeladPath(join(root, "missing-resources")), realpathSync(devBinary));
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
});
