import assert from "node:assert/strict";
import test from "node:test";
import { chatMediaKind, chatMediaMimeType } from "../../packages/chat-render-react/src/resource-media";
import { builtinPreviewAdapters } from "../../packages/file-preview-web/src/builtin-adapters";

test("every built-in media preview is recognized as audio or video by its file host", () => {
  const media = builtinPreviewAdapters.find((adapter) => adapter.id === "media.readonly")!;
  for (const extension of media.extensions) {
    assert.ok(["audio", "video"].includes(chatMediaKind(`clip.${extension}`)), extension);
    assert.ok(["audio", "video"].includes(chatMediaKind(`CLIP.${extension.toUpperCase()}`)), extension);
  }
  assert.equal(chatMediaKind("report.pdf"), "pdf", "retain the existing PDF toolbar download");
  assert.equal(chatMediaKind("unknown.bin"), "file");
  assert.equal(chatMediaMimeType("clip.m4v"), "video/mp4");
  assert.equal(chatMediaMimeType("clip.ogv"), "video/ogg");
});
