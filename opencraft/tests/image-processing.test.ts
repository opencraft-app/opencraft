import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { ImageProcessingService } from "@opencraft/image-processing";
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
