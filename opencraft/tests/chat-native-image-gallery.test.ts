import assert from "node:assert/strict";
import test from "node:test";

import { neighboringNativeGalleryImage, orderedNativeGalleryImages } from "../packages/chat-render-native/src/renderers/image-gallery-model";

test("image preview follows document source order despite asynchronous loads", () => {
  const late = { key: "late", source: "https://example.com/late.png", alt: "Late", order: 20 };
  const early = { key: "early", source: "https://example.com/early.png", alt: "Early", order: 2 };
  const ordered = orderedNativeGalleryImages([late, early]);
  assert.deepEqual(ordered.map(image => image.key), ["early", "late"]);
  assert.equal(neighboringNativeGalleryImage(ordered, "early", 1)?.key, "late");
  assert.equal(neighboringNativeGalleryImage(ordered, "early", -1), null);
  assert.equal(neighboringNativeGalleryImage(ordered, "late", 1), null);
});
