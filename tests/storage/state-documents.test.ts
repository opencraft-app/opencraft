import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryStateDocumentStore } from "@opencraft/document-storage/state";
import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import { STATE_DOCUMENT_CONFORMANCE_CASES } from "@opencraft/document-storage/state-conformance";

for (const conformance of STATE_DOCUMENT_CONFORMANCE_CASES) {
  test(`memory state documents: ${conformance.name}`, () => conformance.run(memoryStateDocumentStore()));
  test(`file state documents: ${conformance.name}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "state-documents-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await conformance.run(fileStateDocumentStore(join(directory, "nested")), async (key) => {
      await fileStateDocumentStore(join(directory, "nested")).update("seed.json", () => ({ result: 0, next: {} }));
      await writeFile(join(directory, "nested", key), "{not json");
    });
  });
}

test("file state documents keep the existing pretty-printed format", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "state-documents-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await fileStateDocumentStore(directory).update("models.json", () => ({ result: 0, next: { revision: 1 } }));
  const { readFile } = await import("node:fs/promises");
  const { strictEqual } = await import("node:assert/strict");
  strictEqual(await readFile(join(directory, "models.json"), "utf8"), '{\n  "revision": 1\n}\n');
});

test("private file state documents refuse symlinks, shared modes and oversized files", async (t) => {
  const { chmod, symlink, writeFile: write } = await import("node:fs/promises");
  const { rejects, deepEqual } = await import("node:assert/strict");
  const { StateDocumentNotPrivateError } = await import("@opencraft/document-storage/state-file");
  const directory = await mkdtemp(join(tmpdir(), "state-private-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = fileStateDocumentStore(directory, { private: { maxBytes: 64 } });
  await store.update("ok.json", () => ({ result: 0, next: { key: "secret" } }));
  deepEqual(await store.read("ok.json"), { key: "secret" });
  await write(join(directory, "shared.json"), "{}"); await chmod(join(directory, "shared.json"), 0o644);
  await write(join(directory, "big.json"), JSON.stringify({ pad: "x".repeat(100) }), { mode: 0o600 });
  await symlink(join(directory, "ok.json"), join(directory, "link.json"));
  for (const key of ["shared.json", "big.json"]) await rejects(store.read(key), StateDocumentNotPrivateError, key);
  await rejects(store.read("link.json"), (error: NodeJS.ErrnoException) => error.code === "ELOOP");
  await rejects(store.update("shared.json", () => ({ result: 0, next: {} })), StateDocumentNotPrivateError);
});
