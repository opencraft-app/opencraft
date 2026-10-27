import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveServerProductEntry, resolveClientProductEntry, resolveEmbeddedProductEntry } from "../../apps/workbench-web/server-product-entry.mjs";

test("embedded entry is absent by default and only trusted local source enables it", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "opencraft-embedded-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(resolveEmbeddedProductEntry(root), null);
  assert.equal(resolveEmbeddedProductEntry(root, "  "), null);
  const product = path.join(root, "product.ts");
  await writeFile(product, "export {};");
  assert.equal(resolveEmbeddedProductEntry(root, "product.ts"), product);
  assert.equal(resolveEmbeddedProductEntry(root, product), product);
  for (const entry of ["missing.ts", "https://untrusted.example/product.ts", "data:text/javascript,", "manifest.json", "."]) {
    assert.throws(() => resolveEmbeddedProductEntry(root, entry), /OPENCRAFT_EMBEDDED_PRODUCT_ENTRY/);
  }
});

test("default client entry works without any downstream product checkout", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "opencraft-client-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(resolveServerProductEntry(root), path.join(root, "apps/workbench-web/src/runtime/server-product-extensions.ts"));
  const product = path.join(root, "product.ts");
  await writeFile(product, "export const serverWorkbenchExtensions = [];");
  assert.equal(resolveServerProductEntry(root, "product.ts"), product);
  assert.equal(resolveServerProductEntry(root, product), product);
});

test("invalid configured client entry fails rather than silently dropping identity", () => {
  for (const entry of ["missing.ts", "https://untrusted.example/product.ts", "data:text/javascript,", "manifest.json", "."]) {
    assert.throws(() => resolveServerProductEntry(import.meta.dirname, entry), /OPENCRAFT_SERVER_EXTENSIONS_ENTRY/);
  }
});


test("client lifecycle entry defaults to public core and validates explicit products", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "opencraft-product-life-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(resolveClientProductEntry(root), path.join(root, "apps/workbench-web/src/runtime/client-product-entry.ts"));
  const product = path.join(root, "product.ts");
  await writeFile(product, "export function clientProductOptions() { return {}; }");
  assert.equal(resolveClientProductEntry(root, "product.ts"), product);
  assert.equal(resolveClientProductEntry(root, product), product);
  for (const entry of ["missing.ts", "https://untrusted.example/product.ts", "data:text/javascript,", "manifest.json", "."]) {
    assert.throws(() => resolveClientProductEntry(root, entry), /OPENCRAFT_CLIENT_PRODUCT_ENTRY/);
  }
});
