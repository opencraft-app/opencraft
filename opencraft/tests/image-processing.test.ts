import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { ImageProcessingService } from "@opencraft/image-processing";
import { processBrowserImage } from "@opencraft/image-processing/browser";
import { inspectImage } from "../packages/image-processing/src/inspect";
test("image service serializes jobs, cancels queued work and retains originals without savings", async () => {
  const ctx = new Context();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fiber = ctx.plugin(ImageProcessingService, {
    process: async (blob: Blob) => {
      calls++;
      await gate;
      return {
        blob: new Blob(["larger output"]),
        changed: true,
        reason: "compressed",
      };
    },
  });
  await fiber;
  const original = new Blob(["tiny"]);
  const first = ctx.imageProcessing.compress(original);
  const abort = new AbortController();
  const second = ctx.imageProcessing.compress(original, {
    signal: abort.signal,
  });
  abort.abort();
  await assert.rejects(second, { name: "AbortError" });
  assert.equal(calls, 1);
  release();
  assert.equal((await first).blob, original);
  const service = ctx.imageProcessing;
  await fiber.dispose();
  await assert.rejects(service.compress(original));
});
test("header inspection is bounded and unsupported animation formats are not decoded", () => {
  assert.equal(inspectImage(new Uint8Array([71, 73, 70, 56, 57, 97])), null);
  assert.equal(
    inspectImage(new Uint8Array([255, 216, 255, 224, 255, 255])),
    null,
  );
});

test("HEIC transcode keeps JPEG even when it is larger than the original", async () => {
  const ctx = new Context();
  const jpeg = new Blob(["jpeg derivative"], { type: "image/jpeg" });
  const fiber = ctx.plugin(ImageProcessingService, {
    process: async () => ({ blob: jpeg, changed: true, reason: "transcoded" }),
  });
  await fiber;
  try {
    const heic = new Blob(["heic"], { type: "image/heic" });
    const result = await ctx.imageProcessing.compress(heic);
    assert.equal(result.blob, jpeg);
    assert.equal(result.changed, true);
    assert.equal(result.reason, "transcoded");
  } finally {
    await fiber.dispose();
  }
});

test("browser HEIC path decodes through an image element, encodes JPEG and releases its URL", async () => {
  const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const revoked: string[] = [];
  const stages: string[] = [];
  let drawn = false;
  class TestImage {
    naturalWidth = 8064;
    naturalHeight = 6048;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    removeAttribute() { /* release the selected image source */ }
  }
  Object.defineProperty(globalThis, "Image", { configurable: true, value: TestImage });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => { drawn = true; } }),
      toBlob: (callback: (value: Blob) => void) => callback(new Blob(["jpeg derivative"], { type: "image/jpeg" })),
    }),
  } });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:heic-test" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: (url: string) => revoked.push(url) });
  try {
    const result = await processBrowserImage(new Blob(["heic"], { type: "image/heic" }), new AbortController().signal, stage => stages.push(stage));
    assert.equal(result.changed, true);
    assert.equal(result.reason, "transcoded");
    assert.equal(result.blob.type, "image/jpeg");
    assert.equal(drawn, true);
    assert.deepEqual(stages, ["decoding", "encoding"]);
    assert.deepEqual(revoked, ["blob:heic-test"]);
    const abort = new AbortController();
    const pending = processBrowserImage(new Blob(["heic"], { type: "image/heic" }), abort.signal, () => undefined);
    abort.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.deepEqual(revoked, ["blob:heic-test", "blob:heic-test"]);
  } finally {
    if (originalImage) Object.defineProperty(globalThis, "Image", originalImage);
    else Reflect.deleteProperty(globalThis, "Image");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate);
    else Reflect.deleteProperty(URL, "createObjectURL");
    if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
    else Reflect.deleteProperty(URL, "revokeObjectURL");
  }
});
