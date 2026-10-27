import { inspectImage } from "./inspect";
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<Blob>) => void;
  postMessage(value: unknown): void;
};
scope.onmessage = async ({ data: blob }) => {
  const original = (reason: string) =>
    scope.postMessage({ result: { blob, changed: false, reason } });
  let bitmap: ImageBitmap | undefined;
  try {
    scope.postMessage({ stage: "inspecting" });
    if (blob.size > 20 * 1024 * 1024) {
      scope.postMessage({ error: "Image exceeds the 20 MiB input limit" });
      return;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const info = inspectImage(bytes);
    if (!info || info.animated) {
      original("unsupported-or-animated");
      return;
    }
    if (
      !info.width ||
      !info.height ||
      info.width * info.height > 24_000_000 ||
      Math.max(info.width, info.height) > 16384
    ) {
      scope.postMessage({
        error:
          "Image exceeds the safe decoding limit (24 megapixels / 16384px edge)",
      });
      return;
    }
    let result: Blob;
    if (info.type === "image/png") {
      // Lossless optimisation of original PNG bytes preserves screenshot pixels
      // and alpha; do not run screenshots through a lossy JPEG canvas.
      scope.postMessage({ stage: "encoding" });
      // Single-thread WASM: no SharedArrayBuffer/COOP/COEP deployment contract
      // and no nested worker pool escaping this service's CPU budget.
      const codec = await import("@jsquash/oxipng/codec/pkg/squoosh_oxipng.js");
      await codec.default();
      const output = codec.optimise(bytes, 2, false, false);
      result = new Blob([output as Uint8Array<ArrayBuffer>], {
        type: info.type,
      });
    } else {
      scope.postMessage({ stage: "decoding" });
      bitmap = await createImageBitmap(new Blob([bytes], { type: info.type }), {
        imageOrientation: "from-image",
      });
      const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(bitmap.width * scale)),
        Math.max(1, Math.round(bitmap.height * scale)),
      );
      const context = canvas.getContext("2d");
      if (!context) {
        original("canvas-unavailable");
        return;
      }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      scope.postMessage({ stage: "encoding" });
      result = await canvas.convertToBlob({ type: info.type, quality: 0.88 });
      if (result.type !== info.type) {
        original("encoder-unavailable");
        return;
      }
    }
    if (result.size >= blob.size) {
      original("no-savings");
      return;
    }
    scope.postMessage({
      result: { blob: result, changed: true, reason: "compressed" },
    });
  } catch {
    original("codec-failed");
  } finally {
    bitmap?.close();
  }
};
