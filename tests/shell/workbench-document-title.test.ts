import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatDocumentTitle } from "../../apps/workbench-web/src/runtime/document-title";

test("document title follows task names without truncating or interpreting markup", () => {
  assert.equal(formatDocumentTitle("clone 一下 opencraft"), "clone 一下 opencraft · OpenCraft");
  assert.equal(formatDocumentTitle(" 更新后的任务名 "), "更新后的任务名 · OpenCraft");
  assert.equal(formatDocumentTitle("<script> & task"), "<script> & task · OpenCraft");
});

test("leaving a task clears its title instead of preserving the previous task", () => {
  for (const title of [null, undefined, "", "  "]) {
    assert.equal(formatDocumentTitle(title), "OpenCraft");
  }
});

test("the standalone shell owns its document title without overriding an embedded host", () => {
  const app = readFileSync(new URL("../../apps/workbench-web/src/app.tsx", import.meta.url), "utf8");
  assert.match(app, /title=\{pageTitle\}/);
  assert.match(app, /formatDocumentTitle\(settingsOpen \? null : pageTitle, applicationName\)/);
  assert.match(app, /if \(embedded !== undefined\) return;\s*document\.title = documentTitle;/);
  assert.match(app, /if \(embedded !== undefined\) return;\s*return \(\) => \{ document\.title = applicationName; \};/);
});
