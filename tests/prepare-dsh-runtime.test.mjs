import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareDshRuntime } from "../scripts/prepare-dsh-runtime.mjs";
import checkDesktopTarget from "../scripts/check-desktop-target.cjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "opencraft-dsh-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, "runtime/dsh");
  await mkdir(runtime, { recursive: true });
  await writeFile(join(root, "package.json"), '{"private":true}');
  await writeFile(join(root, "root-dev-dependency"), "untouched");
  const dependencies = { "@deepseek-ai/dsh": "0.1.1-rc.2" };
  await writeFile(join(runtime, "package.json"), JSON.stringify({ dependencies }));
  await writeFile(join(runtime, "package-lock.json"), JSON.stringify({ packages: {
    "": { dependencies }, "node_modules/@deepseek-ai/dsh": { version: "0.1.1-rc.2" },
  } }));
  let installs = 0;
  async function install(directory) {
    assert.equal(directory, runtime);
    installs++;
    const entry = join(runtime, "node_modules/@deepseek-ai/dsh");
    await mkdir(join(entry, "lib"), { recursive: true });
    await writeFile(join(entry, "package.json"), '{"version":"0.1.1-rc.2"}');
    await writeFile(join(entry, "lib/bin.js"), "// fixture");
  }
  return { root, runtime, install, installs: () => installs };
}

test("missing manifest fails before npm can fall back to the root project", async t => {
  const f = await fixture(t);
  await rm(join(f.runtime, "package.json"));
  await assert.rejects(prepareDshRuntime(f), /ENOENT/);
  assert.equal(f.installs(), 0);
  assert.equal(await readFile(join(f.root, "root-dev-dependency"), "utf8"), "untouched");
});

test("inconsistent lockfile fails before installation", async t => {
  const f = await fixture(t);
  await writeFile(join(f.runtime, "package-lock.json"), "{}");
  await assert.rejects(prepareDshRuntime(f), /matching exact versions/);
  assert.equal(f.installs(), 0);
});

test("ready requires an installed executable, not just npm exiting successfully", async t => {
  const f = await fixture(t);
  await assert.rejects(prepareDshRuntime({ ...f, install: async () => {} }), /ENOENT/);
  await assert.rejects(access(join(f.runtime, ".opencraft-dsh-install.json")), /ENOENT/);
});

test("verified installation is reusable but lockfile changes invalidate it", async t => {
  const f = await fixture(t);
  await prepareDshRuntime(f);
  await prepareDshRuntime(f);
  assert.equal(f.installs(), 1);
  const lockPath = join(f.runtime, "package-lock.json");
  await writeFile(lockPath, `${await readFile(lockPath, "utf8")}\n`);
  await prepareDshRuntime(f);
  assert.equal(f.installs(), 2);
});

test("deleting the runtime executable forces a repair even with a ready stamp", async t => {
  const f = await fixture(t);
  const executable = await prepareDshRuntime(f);
  await rm(executable);
  await prepareDshRuntime(f);
  assert.equal(f.installs(), 2);
});

test("installer failure never creates a success stamp", async t => {
  const f = await fixture(t);
  await assert.rejects(prepareDshRuntime({ ...f, install: async () => { throw new Error("network unavailable"); } }), /network unavailable/);
  await assert.rejects(access(join(f.runtime, ".opencraft-dsh-install.json")), /ENOENT/);
});

test("desktop packaging refuses foreign native modules", async () => {
  const arches = { ia32: 0, x64: 1, armv7l: 2, arm64: 3 };
  const arch = arches[process.arch];
  if (arch !== undefined) await checkDesktopTarget({ electronPlatformName: process.platform, arch });
  await assert.rejects(checkDesktopTarget({ electronPlatformName: "not-this-os", arch: 1 }), /requires a native/);
  await assert.rejects(checkDesktopTarget({ electronPlatformName: process.platform, arch: 4 }), /requires a native/);
});

test("Mac ZIP matrix artifacts match electron-builder naming", async () => {
  const app = JSON.parse(await readFile(new URL("../apps/workbench-electron/package.json", import.meta.url), "utf8"));
  const matrix = JSON.parse(await readFile(new URL("../config/build-matrix.json", import.meta.url), "utf8"));
  for (const arch of ["arm64", "x64"]) {
    const name = app.build.artifactName.replace("${version}", app.version)
      .replace("${os}", "mac").replace("${arch}", arch).replace("${ext}", "zip");
    const target = matrix.targets.find(target => target.id === `electron-macos-${arch}-zip`);
    assert.deepEqual(target.artifacts, [`apps/workbench-electron/release/${name}`]);
  }
});
