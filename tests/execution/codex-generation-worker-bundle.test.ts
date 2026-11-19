import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

for (const format of ["cjs", "esm"] as const) test(`packaged ${format} registry opens its colocated Worker and refuses a missing Worker`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "registry-bundle-"));
  const banner = { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" };
  try {
    const runtime = join(directory, `runtime.${format === "cjs" ? "cjs" : "mjs"}`);
    const worker = join(directory, "generation-registry-worker.mjs");
    await build({ entryPoints: [resolve("apps/codex-core/src/generation-registry-worker.ts")], outfile: runtime, bundle: true, platform: "node", format, target: "node26", banner: format === "esm" ? banner : undefined, logLevel: "silent" });
    await build({ entryPoints: [resolve("apps/codex-core/src/generation-registry.worker.ts")], outfile: worker, bundle: true, platform: "node", format: "esm", target: "node26", banner, logLevel: "silent" });
    const { GenerationRegistryWorker } = await import(pathToFileURL(runtime).href);
    const registry = await GenerationRegistryWorker.open(join(directory, "data"));
    await registry.setMetadata("proof", { committed: true });
    assert.deepEqual(registry.metadata("proof"), { committed: true });
    await registry.close();
    await unlink(worker);
    await assert.rejects(GenerationRegistryWorker.open(join(directory, "data")), /Cannot find module/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
