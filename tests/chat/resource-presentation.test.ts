import assert from "node:assert/strict";
import test from "node:test";
import { chatWebLinkLabel } from "../../packages/chat-render-react/src/resource-presentation";

import { chatFilePresentation } from "../../packages/chat-render-react/src/file-resource-presentation";

test("file labels hide directories while preserving type and source location", () => {
  assert.deepEqual(chatFilePresentation("file:///work/app/main.ts:42"), { name: "main.ts", location: "L42", appearance: "code" });
  assert.deepEqual(chatFilePresentation("C:\\work\\report.xlsx#L4-L8"), { name: "report.xlsx", location: "L4–8", appearance: "spreadsheet" });
  assert.equal(chatFilePresentation("file:///work/%E6%8A%A5%E5%91%8A.pdf").name, "报告.pdf");
  for (const [path, appearance] of [["image.png", "image"], ["song.mp3", "audio"], ["movie.mp4", "video"], ["archive.zip", "archive"], ["/work/docs/", "folder"], ["README.md", "document"]]) {
    assert.equal(chatFilePresentation(path!).appearance, appearance);
  }
});

test("authored labels remain useful while path labels and raw URLs are compact", () => {
  assert.equal(chatFilePresentation("file:///work/docs/README.md", "项目说明").name, "项目说明");
  assert.equal(chatFilePresentation("file:///work/docs/README.md", "/work/docs/README.md").name, "README.md");
  assert.equal(chatFilePresentation("file:///work/docs/README.md", "API / Documentation").name, "API / Documentation");
  assert.equal(chatFilePresentation("file:///work/main.ts#L42", "main.ts:42").name, "main.ts");
  assert.equal(chatWebLinkLabel("https://example.org/very/long?query=1", "https://example.org/very/long?query=1"), "example.org");
  assert.equal(chatWebLinkLabel("https://example.org/guide", "使用指南"), "使用指南");
});
