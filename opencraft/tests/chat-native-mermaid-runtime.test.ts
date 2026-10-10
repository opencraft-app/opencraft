import assert from "node:assert/strict";
import test from "node:test";

import { nativeMermaidPreviewHeight, parseMermaidRuntimeMessage } from "../packages/chat-render-native/src/renderers/mermaid-runtime-model";
import { allowEmbeddedDocumentNavigation } from "../packages/chat-render-native/src/renderers/embedded-rich-runtime-policy";

test("native Mermaid runtime only accepts bounded render results", () => {
  assert.deepEqual(parseMermaidRuntimeMessage('{"type":"ready"}'), { type: "ready" });
  assert.deepEqual(parseMermaidRuntimeMessage('{"type":"rendered","revision":2,"width":400,"height":200}'), {
    type: "rendered", revision: 2, width: 400, height: 200,
  });
  assert.deepEqual(parseMermaidRuntimeMessage('{"type":"failed","revision":3}'), { type: "failed", revision: 3 });
  for (const data of [
    "not json",
    '{"type":"rendered","revision":0,"width":400,"height":200}',
    '{"type":"rendered","revision":1,"width":0,"height":200}',
    '{"type":"rendered","revision":1,"width":100001,"height":200}',
    '{"type":"rendered","revision":1,"width":"400","height":200}',
  ]) assert.equal(parseMermaidRuntimeMessage(data), null);
});

test("native Mermaid preview scales inside a bounded transcript slot", () => {
  assert.equal(nativeMermaidPreviewHeight(360, 720, 400), 200);
  assert.equal(nativeMermaidPreviewHeight(360, 100, 1000), 480);
  assert.equal(nativeMermaidPreviewHeight(360, 1000, 50), 96);
  assert.equal(nativeMermaidPreviewHeight(0, 720, 400), 240);
});

test("embedded rich documents accept only their initial local navigation", () => {
  assert.equal(allowEmbeddedDocumentNavigation("about:blank", false), true);
  assert.equal(allowEmbeddedDocumentNavigation("data:text/html;base64,PGh0bWw+", false), true);
  assert.equal(allowEmbeddedDocumentNavigation("data:text/html;charset=UTF-8,<html>", false), true);
  assert.equal(allowEmbeddedDocumentNavigation("data:text/html;base64,PGh0bWw+", true), false);
  assert.equal(allowEmbeddedDocumentNavigation("data:text/javascript,alert(1)", false), false);
  assert.equal(allowEmbeddedDocumentNavigation("https://example.com", false), false);
});
