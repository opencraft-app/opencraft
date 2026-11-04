import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  electronAppEnvironment,
  electronLaunchSpec,
  startElectron,
} from "../../scripts/start-electron.mjs";
import {
  distributionEnvironmentKey,
  electronDistributionForTarget,
  packageBuilderArguments,
  packageTarget,
} from "../../scripts/package-electron-desktop.mjs";
import { verifyElectronDistribution } from "../../scripts/electron-distribution.mjs";

test("Electron app launch removes inherited Node mode without mutating the source environment", () => {
  const source = { ELECTRON_RUN_AS_NODE: "1", OPENCRAFT_TEST_VALUE: "kept" };
  const environment = electronAppEnvironment(source);

  assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(environment.OPENCRAFT_TEST_VALUE, "kept");
  assert.equal(source.ELECTRON_RUN_AS_NODE, "1");
});

test("Electron launch resolves the real binary, application root and caller arguments", () => {
  const launch = electronLaunchSpec(["--user-data-dir=/tmp/profile", "--remote-debugging-port=9472"], {
    ELECTRON_RUN_AS_NODE: "1",
  });

  assert.match(launch.executable, /electron(?:\.app[\\/]Contents[\\/]MacOS[\\/]Electron|\.exe)?$/iu);
  assert.match(launch.args[0], /apps[\\/]workbench-electron$/u);
  assert.deepEqual(launch.args.slice(1), [
    "--user-data-dir=/tmp/profile",
    "--remote-debugging-port=9472",
  ]);
  assert.equal(launch.options.env.ELECTRON_RUN_AS_NODE, undefined);
});

test("desktop launch can select an explicitly supplied fork executable", () => {
  const launch = electronLaunchSpec([], { OPENCRAFT_ELECTRON_EXECUTABLE: "/opt/opencraft/Electron" });
  assert.equal(launch.executable, "/opt/opencraft/Electron");
  assert.equal(launch.options.env.OPENCRAFT_ELECTRON_EXECUTABLE, undefined);
});

test("desktop release packaging refuses an unverified stock runtime", async () => {
  await assert.rejects(
    packageBuilderArguments(["--win", "nsis"], {}),
    /requires OPENCRAFT_ELECTRON_DISTRIBUTION/u,
  );
  assert.deepEqual(
    await packageBuilderArguments(["--win", "nsis"], { OPENCRAFT_ELECTRON_ALLOW_STOCK: "1" }),
    ["--win", "nsis"],
  );
});

test("desktop fork provenance follows the requested target, not the build host", () => {
  assert.deepEqual(packageTarget(["--mac", "zip", "--x64"], {
    platform: "darwin",
    arch: "arm64",
  }), { platform: "darwin", arch: "x64" });
  assert.deepEqual(packageTarget(["--win", "nsis", "--x64"], {
    platform: "darwin",
    arch: "arm64",
  }), { platform: "win32", arch: "x64" });
});

test("desktop packaging selects a target-specific native artifact before the generic fallback", () => {
  const target = { platform: "win32", arch: "x64" };
  assert.equal(distributionEnvironmentKey(target), "OPENCRAFT_ELECTRON_DISTRIBUTION_WIN32_X64");
  assert.deepEqual(
    electronDistributionForTarget({
      OPENCRAFT_ELECTRON_DISTRIBUTION: "/opt/generic",
      OPENCRAFT_ELECTRON_DISTRIBUTION_WIN32_X64: "/opt/windows",
    }, target),
    { key: "OPENCRAFT_ELECTRON_DISTRIBUTION_WIN32_X64", path: "/opt/windows" },
  );
  assert.deepEqual(
    electronDistributionForTarget({ OPENCRAFT_ELECTRON_DISTRIBUTION: "/opt/generic" }, target),
    { key: "OPENCRAFT_ELECTRON_DISTRIBUTION", path: "/opt/generic" },
  );
});

test("desktop fork verification rejects changed bytes after stamping", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-electron-distribution-test-"));
  try {
    const executable = join(directory, "electron");
    const forkDefinition = join(directory, "..", "opencraft-fork-fixture.json");
    await writeFile(executable, "native fork executable fixture\n");
    await writeFile(forkDefinition, JSON.stringify({ version: "44.8.0", chromiumVersion: "152.0.7977.167" }));
    const digest = value => createHash("sha256").update(value).digest("hex");
    const executableBytes = await readFile(executable);
    const forkBytes = await readFile(forkDefinition);
    await writeFile(join(directory, "opencraft-electron-desktop-artifact.json"), JSON.stringify({
      schemaVersion: 1,
      platform: "linux",
      arch: "x64",
      executable: "electron",
      executableSha256: digest(executableBytes),
      forkDefinitionSha256: digest(forkBytes),
      electronVersion: "44.8.0",
      chromiumVersion: "152.0.7977.167",
      nativeProbePassed: true,
      files: [{ path: "electron", type: "file", size: executableBytes.length, sha256: digest(executableBytes) }],
    }));
    const verified = await verifyElectronDistribution(directory, forkDefinition, {
      platform: "linux", arch: "x64",
    });
    assert.equal(verified.executable, executable);
    await writeFile(executable, "tampered bytes\n");
    await assert.rejects(
      verifyElectronDistribution(directory, forkDefinition, { platform: "linux", arch: "x64" }),
      /byte inventory mismatch/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(join(directory, "..", "opencraft-fork-fixture.json"), { force: true });
  }
});

test("startElectron passes the sanitized launch contract to the child process", async () => {
  const child = new EventEmitter();
  let observed;
  const started = startElectron(["--diagnostic"], {
    environment: { ELECTRON_RUN_AS_NODE: "1", PRESERVED: "yes" },
    spawnImpl(executable, args, options) {
      observed = { executable, args, options };
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });

  await started;
  assert.equal(observed.options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(observed.options.env.PRESERVED, "yes");
  assert.deepEqual(observed.args.slice(1), ["--diagnostic"]);
});

test("the workbench start script uses the sanitized Electron launcher", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../../apps/workbench-electron/package.json", import.meta.url),
    "utf8",
  ));
  assert.equal(
    manifest.scripts.start,
    "npm run build:host && node ../../scripts/start-electron.mjs",
  );
});

test("all desktop package targets use the verified Electron packaging wrapper", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../../apps/workbench-electron/package.json", import.meta.url),
    "utf8",
  ));
  const packageScripts = Object.entries(manifest.scripts)
    .filter(([name]) => name.startsWith("package:"));
  assert.ok(packageScripts.length > 0);
  for (const [name, command] of packageScripts) {
    if (name.endsWith(":preview")) continue;
    assert.match(command, /node \.\.\/\.\.\/scripts\/package-electron-desktop\.mjs/u);
  }
  const preview = await readFile(
    new URL("../../scripts/package-macos-preview.mjs", import.meta.url),
    "utf8",
  );
  assert.match(preview, /packageBuilderArguments/u);
});

test("native packaging workflows cannot bypass the fork wrapper", async () => {
  const buildMatrix = await readFile(
    new URL("../../.github/workflows/build-matrix.yml", import.meta.url),
    "utf8",
  );
  const universal = await readFile(
    new URL("../../.github/workflows/macos-universal-release.yml", import.meta.url),
    "utf8",
  );
  const nativeArtifacts = await readFile(
    new URL("../../.github/workflows/electron-native-artifacts.yml", import.meta.url),
    "utf8",
  );
  assert.match(buildMatrix, /package:mac:arm64:dmg --workspace @opencraft\/workbench-electron/u);
  assert.match(buildMatrix, /OPENCRAFT_ELECTRON_DISTRIBUTION_DARWIN_ARM64/u);
  assert.doesNotMatch(buildMatrix, /npm exec --workspace @opencraft\/workbench-electron -- electron-builder --mac/u);
  assert.match(universal, /package-electron-desktop\.mjs --mac dir --arm64/u);
  assert.match(universal, /package-electron-desktop\.mjs --mac dir --x64/u);
  assert.match(universal, /OPENCRAFT_ELECTRON_DISTRIBUTION_DARWIN_ARM64/u);
  assert.match(universal, /OPENCRAFT_ELECTRON_DISTRIBUTION_DARWIN_X64/u);
  assert.match(universal, /opencraft-electron-desktop-artifact\.json/u);
  for (const target of ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"]) {
    assert.match(nativeArtifacts, new RegExp(target, "u"));
  }
  assert.match(nativeArtifacts, /manage\.py build/u);
  assert.match(nativeArtifacts, /dist\.zip/u);
  assert.match(nativeArtifacts, /prepare-desktop-artifact\.py/u);
  assert.match(nativeArtifacts, /opencraft-electron-desktop-artifact\.json/u);
});
