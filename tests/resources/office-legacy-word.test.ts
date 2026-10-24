import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseDocxForViewer, setWasmSource } from "@extend-ai/react-docx";
import { previewLinkTarget } from "../../packages/file-preview-web/src/links";

setWasmSource(await readFile(new URL("../../node_modules/@extend-ai/react-docx/dist/docx_wasm_bg.wasm", import.meta.url)));
test("legacy Word CFB is parsed into Chinese and English paragraphs", async () => {
  const data = await readFile(new URL("../fixtures/office/sample.doc", import.meta.url));
  const parsed = await parseDocxForViewer(data, { useWorker: false, loadEmbeddedFonts: false });
  try {
    assert.equal(parsed.model.nodes.length, 4);
    assert.match(JSON.stringify(parsed.model.nodes), /Legacy Word preview/);
    assert.match(JSON.stringify(parsed.model.nodes), /中文旧版 Word 文档/);
  } finally { parsed.dispose(); }
});
test("encrypted legacy Word is rejected before document rendering", async () => {
  const data = await readFile(new URL("../fixtures/office/sample.doc", import.meta.url));
  data.writeUInt16LE(data.readUInt16LE(512 + 10) | 0x100, 512 + 10);
  await assert.rejects(parseDocxForViewer(data, { useWorker: false, loadEmbeddedFonts: false }), /encrypt/iu);
});
test("imported links reject navigation schemes, credentials and control characters", () => {
  for (const link of ["javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "//example.com", "../secret", "https://user:pass@example.com", "https://example.com/\nsecret", "#"]) assert.equal(previewLinkTarget(link), null, link);
  assert.equal(previewLinkTarget(" https://example.com/guide "), "https://example.com/guide");
  assert.equal(previewLinkTarget("#chapter-1"), "#chapter-1");
});
