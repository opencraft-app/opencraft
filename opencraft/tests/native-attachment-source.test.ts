import assert from "node:assert/strict";
import test from "node:test";
const sourceModule = await import("../apps/workbench-expo/src/runtime/native-attachment-source.ts");
const { prepareNativeAttachmentSource } = sourceModule.default ?? sourceModule;

test("a photo without MIME keeps its real image format when the URI supplies it", () => {
  assert.deepEqual(prepareNativeAttachmentSource({
    uri: "file:///cache/IMG_001.HEIC?copy=1", name: null, mimeType: null, size: 123,
  }, "photo", "one"), {
    uri: "file:///cache/IMG_001.HEIC?copy=1", name: "photo-one.heic", mimeType: "image/heic", size: 123,
  });
});

test("a photo with no useful metadata stays on the image conversion path", () => {
  const prepared = prepareNativeAttachmentSource({ uri: "file:///cache/picker.tmp" }, "photo", "two");
  assert.equal(prepared.name, "photo-two.jpg");
  assert.equal(prepared.mimeType, "image/unknown");
});

test("a picked file uses its extension only when the picker omits MIME", () => {
  assert.equal(prepareNativeAttachmentSource({
    uri: "file:///cache/blob", name: "notes.PDF", mimeType: "application/octet-stream",
  }, "file", "three").mimeType, "application/pdf");
  assert.equal(prepareNativeAttachmentSource({
    uri: "file:///cache/blob", name: "custom.bin", mimeType: "application/x-custom",
  }, "file", "four").mimeType, "application/x-custom");
});
