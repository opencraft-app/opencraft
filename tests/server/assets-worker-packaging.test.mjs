import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildAssetsRuntime } from "../../scripts/packaging/package-assets-runtime.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
test("bundled assets owner opens its sibling Worker, persists and drains without source-tree fallback", async () => {
  const output = await mkdtemp(join(tmpdir(), "assets-worker-package-"));
  try {
    await buildAssetsRuntime(output);
    await build({
      entryPoints: [join(root, "plugins/assets/src/server/worker.ts")],
      outfile: join(output, "assets-api.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node26",
      logLevel: "silent",
    });
    const { openAssetConfigurations } = await import(pathToFileURL(join(output, "assets-api.mjs")).href);
    const owner = await openAssetConfigurations(join(output, "data"));
    try {
      const permit = new Int32Array(new SharedArrayBuffer(4));
      Atomics.store(permit, 0, 1);
      const access = {
        scope: "actor:human://fixture/bundled",
        canManagePlatform: false,
        allowCustomEndpoints: false,
        expiresAt: Date.now() + 60_000,
        permit,
      };
      assert.equal((await owner.store.snapshot(access)).revision, 0);
      const saved = await owner.store.update(access, {
        action: "save-credential",
        revision: 0,
        name: "E2B",
        apiUrl: "https://api.e2b.dev",
        sandboxUrl: "https://e2b.dev",
        apiKey: "bundled-fixture-not-real",
      });
      assert.equal(saved.revision, 1);
      assert.ok(!JSON.stringify(saved).includes("bundled-fixture-not-real"));
    } finally {
      await owner.close();
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
