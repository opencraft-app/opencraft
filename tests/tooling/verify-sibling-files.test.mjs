import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { siblingReferences, verifySiblingFiles } from "../../scripts/packaging/verify-sibling-files.mjs";

test("bundle sibling references are read in ESM, CommonJS and owner-entry forms", () => {
  const source = [
    'new Worker(new URL("./storage.worker.mjs", import.meta.url));',
    "spawn(new URL('./sandbox-command.mjs', import_meta_url));",
    'WorkerOwner.open(ownerEntry(import.meta.url, "assets-configuration"));',
    // Source fallbacks and other files are not packaged siblings.
    'new URL("./store.worker.ts", import.meta.url); new URL("../elsewhere.mjs", import.meta.url);',
  ].join("\n");
  assert.deepEqual([...siblingReferences(source)].sort(), [
    "assets-configuration-worker.mjs",
    "sandbox-command.mjs",
    "storage.worker.mjs",
  ]);
});

test("a bundle starting a file that was not built beside it fails the package", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sibling-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "codex-bridge"));
  await writeFile(join(root, "gateway.mjs"), 'new Worker(new URL("./storage.worker.mjs", import.meta.url));');
  await writeFile(
    join(root, "codex-bridge", "engine-host.mjs"),
    'new Worker(new URL("./storage.worker.mjs", import.meta.url));',
  );
  await writeFile(join(root, "codex-bridge", "storage.worker.mjs"), "");
  await assert.rejects(
    verifySiblingFiles(root, { nested: ["codex-bridge", "absent"] }),
    /gateway\.mjs -> storage\.worker\.mjs/u,
  );
  await writeFile(join(root, "storage.worker.mjs"), "");
  assert.deepEqual(await verifySiblingFiles(root, { nested: ["codex-bridge"] }), []);
  // A feature the build leaves out is named with its reason.
  await writeFile(join(root, "daemon.cjs"), "new URL('./pi-shell-worker.mjs', import_meta_url)");
  assert.deepEqual(await verifySiblingFiles(root, { optional: { "pi-shell-worker.mjs": "Pi is not shipped" } }), []);
});
