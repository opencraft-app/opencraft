import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexPlatformPackage, stageCodexRuntime } from "../../scripts/packaging/stage-codex-runtime.mjs";

async function fixture(t, { version = "0.162.1", layoutVersion = version } = {}) {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "runtime/codex"), { recursive: true });
  await writeFile(
    join(root, "runtime/codex/package.json"),
    JSON.stringify({ dependencies: { "@openai/codex": version } }),
  );
  const installs = [];
  const install = async (runtime, target) => {
    installs.push(target);
    const vendor = join(runtime, "node_modules", codexPlatformPackage(target), "vendor", "aarch64-apple-darwin");
    await mkdir(join(vendor, "bin"), { recursive: true });
    await mkdir(join(vendor, "codex-resources"), { recursive: true });
    await writeFile(join(vendor, "bin/codex"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(join(vendor, "codex-resources/marker"), "resource");
    await mkdir(join(vendor, "codex-resources/voice/bin"), { recursive: true });
    await writeFile(join(vendor, "codex-resources/voice/bin/codex-voice-host"), "voice");
    await writeFile(
      join(vendor, "codex-package.json"),
      JSON.stringify({ version: layoutVersion, target: "aarch64-apple-darwin", entrypoint: "bin/codex" }),
    );
  };
  return { root, install, installs, staging: join(root, "staged") };
}

test("stages the target's pinned Codex vendor tree in Codex's own layout", async (t) => {
  const { root, install, installs, staging } = await fixture(t);
  const staged = await stageCodexRuntime({ platform: "darwin", arch: "arm64" }, { root, install, staging });
  const output = join(staging, "codex-arm64");
  assert.equal(staged.output, output, "staged under an architecture-qualified directory");
  assert.deepEqual(installs, [{ platform: "darwin", arch: "arm64" }]);
  assert.equal(staged.version, "0.162.1");
  assert.equal((await stat(join(output, "bin/codex"))).mode & 0o111, 0o111, "the binary stays executable");
  assert.equal(await readFile(join(output, "codex-resources/marker"), "utf8"), "resource");
  await assert.rejects(
    stat(join(output, "codex-resources/voice")),
    { code: "ENOENT" },
    "the unused voice pipeline is not shipped",
  );
});

test("refuses a vendor tree that is not the pinned version or an unsupported target", async (t) => {
  const mismatched = await fixture(t, { layoutVersion: "0.163.0" });
  await assert.rejects(
    stageCodexRuntime({ platform: "darwin", arch: "arm64" }, mismatched),
    /does not match the pinned 0\.162\.1/,
  );
  const unpinned = await fixture(t, { version: "^0.162.1" });
  await assert.rejects(
    stageCodexRuntime({ platform: "darwin", arch: "arm64" }, unpinned),
    /exact @openai\/codex version/,
  );
  assert.throws(() => codexPlatformPackage({ platform: "freebsd", arch: "x64" }), /No bundled Codex/);
});
