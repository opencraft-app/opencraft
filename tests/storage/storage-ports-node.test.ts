import { test } from "node:test";
import { chmod, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { memoryStateDocumentStore } from "@opencraft/document-storage/state";
import { memoryKeyMaterial } from "@opencraft/secret-storage";
import { documentSecretStore } from "@opencraft/secret-storage/documents";
import { fileKeyMaterial, fileSecretStore } from "@opencraft/secret-storage/file";
import { SECRET_CONFORMANCE_CASES } from "@opencraft/secret-storage/conformance";
import { memoryBlobStore } from "@opencraft/blob-storage/memory";
import { fileBlobStore } from "@opencraft/blob-storage/file";
import { BLOB_CONFORMANCE_CASES } from "@opencraft/blob-storage/conformance";

async function directory(t: { after(fn: () => unknown): void }) {
  const path = await mkdtemp(join(tmpdir(), "storage-ports-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

for (const conformance of SECRET_CONFORMANCE_CASES) {
  test(`memory secrets: ${conformance.name}`, () => conformance.run({ secrets: documentSecretStore(memoryStateDocumentStore()), keys: memoryKeyMaterial() }));
  test(`file secrets: ${conformance.name}`, async (t) => {
    const root = await directory(t);
    await conformance.run({ secrets: fileSecretStore(root), keys: fileKeyMaterial(join(root, "keys")) });
  });
}
for (const conformance of BLOB_CONFORMANCE_CASES) {
  test(`memory blobs: ${conformance.name}`, () => conformance.run(memoryBlobStore()));
  test(`file blobs: ${conformance.name}`, async (t) => conformance.run(fileBlobStore(join(await directory(t), "blobs"))));
}

test("file secrets and keys are private files", async (t) => {
  const root = await directory(t);
  await fileSecretStore(root).set("API_KEY", "value");
  await fileKeyMaterial(root).ensure("vault.key", () => new Uint8Array([1, 2, 3]));
  for (const name of ["credentials.json", "vault.key"]) assert.equal((await stat(join(root, name))).mode & 0o777, 0o600, name);
});

test("file key material refuses shared or symlinked key files", async (t) => {
  const root = await directory(t), keys = fileKeyMaterial(root);
  await keys.ensure("shared.key", () => new Uint8Array([1]));
  await chmod(join(root, "shared.key"), 0o640);
  await assert.rejects(keys.read("shared.key"), /must be private/);
  await assert.rejects(keys.ensure("shared.key", () => new Uint8Array([2])), /must be private/);
  await writeFile(join(root, "target"), "x", { mode: 0o600 });
  await symlink(join(root, "target"), join(root, "linked.key"));
  await assert.rejects(keys.read("linked.key"));
});

test("file blob staging leaves no residue after completion, abort or limit failure", async (t) => {
  const root = join(await directory(t), "blobs"), store = fileBlobStore(root);
  await store.put("a", new Uint8Array([1]), { maxBytes: 1 });
  await (await store.upload("b", { maxBytes: 8 })).abort();
  await assert.rejects(store.put("c", new Uint8Array([1, 2]), { maxBytes: 1 }));
  assert.deepEqual(await readdir(join(root, ".staging")), []);
});
