import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatDocumentTitle } from "../apps/workbench-web/src/runtime/document-title";

test("document title follows task names without truncating or interpreting markup", () => {
  assert.equal(formatDocumentTitle("clone 一下 mono2"), "clone 一下 mono2 · OpenCraft");
  assert.equal(formatDocumentTitle(" 更新后的任务名 "), "更新后的任务名 · OpenCraft");
  assert.equal(formatDocumentTitle("<script> & task"), "<script> & task · OpenCraft");
});

test("leaving a task clears its title instead of preserving the previous task", () => {
  for (const title of [null, undefined, "", "  "]) {
    assert.equal(formatDocumentTitle(title), "OpenCraft");
  }
});

test("the shell shares its page title with the document and resets settings/unmount", () => {
  const app = readFileSync(new URL("../apps/workbench-web/src/app.tsx", import.meta.url), "utf8");
  assert.match(app, /title=\{pageTitle\}/);
  assert.match(app, /formatDocumentTitle\(settingsOpen \? null : pageTitle\)/);
  assert.match(app, /document\.title = documentTitle;\s*\}, \[documentTitle\]\)/);
  assert.match(app, /useEffect\(\(\) => \(\) => \{ document\.title = "OpenCraft"; \}, \[\]\)/);
});
