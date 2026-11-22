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
