import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareDshRuntime } from "../scripts/prepare-dsh-runtime.mjs";
import checkDesktopTarget from "../scripts/check-desktop-target.cjs";
import { providerLifecycleEdits, nativeProviderLifecycleEdits, patchDshProviderLifecycle } from "../scripts/patch-dsh-provider-lifecycle.mjs";

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
    const pi = join(runtime, "node_modules/@deepseek-ai/dsh-llm-pi-ai/lib");
    await mkdir(pi, { recursive: true });
    await writeFile(join(pi, "index.js"), providerLifecycleEdits.map(([before]) => before).join("\n"));
    const native = join(runtime, "node_modules/@deepseek-ai/dsh-llm-deepseek/lib");
    await mkdir(native, { recursive: true });
    await writeFile(join(native, "index.js"), nativeProviderLifecycleEdits.map(([before]) => before).join("\n"));
  }
  return { root, runtime, install, installs: () => installs };
}

test("provider lifecycle patch is idempotent and rejects upstream drift", async t => {
  const f = await fixture(t);
  await f.install(f.runtime);
  await patchDshProviderLifecycle(f.runtime);
  const path = join(f.runtime, "node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js");
  const once = await readFile(path, "utf8");
  const nativePath = join(f.runtime, "node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js");
  const nativeOnce = await readFile(nativePath, "utf8");
  await patchDshProviderLifecycle(f.runtime);
  assert.equal(await readFile(path, "utf8"), once);
  assert.equal(await readFile(nativePath, "utf8"), nativeOnce);
  await writeFile(path, "// unsupported upstream revision");
  await assert.rejects(patchDshProviderLifecycle(f.runtime), /no longer matches/);
  assert.equal(await readFile(path, "utf8"), "// unsupported upstream revision");
});

test("missing manifest fails before npm can fall back to the root project", async t => {
  const f = await fixture(t);
  await rm(join(f.runtime, "package.json"));
  await assert.rejects(prepareDshRuntime(f), /ENOENT/);
  assert.equal(f.installs(), 0);
  assert.equal(await readFile(join(f.root, "root-dev-dependency"), "utf8"), "untouched");
});

test("native adapter drift is rejected before either adapter is rewritten", async t => {
  const f = await fixture(t);
  await f.install(f.runtime);
  const pi = join(f.runtime, "node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js");
  const before = await readFile(pi, "utf8");
  await writeFile(join(f.runtime, "node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js"), "// unknown native version");
  await assert.rejects(patchDshProviderLifecycle(f.runtime), /no longer matches/);
  assert.equal(await readFile(pi, "utf8"), before);
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
