import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const banner = { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" };

test("bundled notification worker opens, generates keys and closes beside its owner", async () => {
  const output = await mkdtemp(join(tmpdir(), "notification-worker-package-"));
  try {
    const options = { bundle: true, platform: "node", format: "esm", target: "node26", banner, logLevel: "silent" };
    await build({
      ...options,
      entryPoints: [join(root, "packages/web-push-node/src/store.worker.ts")],
      outfile: join(output, "push-storage-worker.mjs"),
    });
    await build({
      ...options,
      entryPoints: [join(root, "packages/web-push-node/src/async-store.ts")],
      outfile: join(output, "push-api.mjs"),
    });
    const { openPushStore } = await import(pathToFileURL(join(output, "push-api.mjs")).href);
    const store = await openPushStore(join(output, "notifications.sqlite"));
    try {
      assert.equal(store.outcome.appliedVersion, 2);
      const keys = await store.keys();
      assert.ok(keys.publicKey && keys.privateKey);
      assert.deepEqual(await store.keys(), keys);
    } finally {
      await store.close();
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("web and headless release packaging both include the notification worker", async () => {
  for (const name of ["package-web-server.mjs", "package-headless-linux.mjs"]) {
    const source = await readFile(join(root, "scripts", name), "utf8");
    assert.match(source, /packages\/web-push-node\/src\/store\.worker\.ts/);
    assert.match(source, /push-storage-worker\.mjs/);
  }
});
