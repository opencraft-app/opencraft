import type { ImageProcessor, ImageStage, ImageResult } from "./service";

const isHeic = (type: string) => type === "image/heic" || type === "image/heif";

/** A browser may display a selected HEIC while the worker's header codec cannot inspect it. */
function transcodeHeic(blob: Blob, signal: AbortSignal, progress: (stage: ImageStage) => void): Promise<ImageResult> {
  if (typeof Image === "undefined" || typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    return Promise.resolve({ blob, changed: false, reason: "codec-unavailable" });
  }
  if (blob.size > 20 * 1024 * 1024) {
    return Promise.reject(new Error("Image exceeds the 20 MiB input limit"));
  }
  return new Promise((resolve, reject) => {
    let url: string;
    try { url = URL.createObjectURL(blob); }
    catch {
      resolve({ blob, changed: false, reason: "codec-unavailable" });
      return;
    }
    const image = new Image();
    let settled = false;
    const finish = (result?: ImageResult, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => finish(undefined, new DOMException("Image processing cancelled", "AbortError"));
    const timer = setTimeout(() => finish({ blob, changed: false, reason: "timeout" }), 20_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    progress("decoding");
    image.onerror = () => finish({ blob, changed: false, reason: "codec-unavailable" });
    image.onload = () => {
      if (settled) return;
      const { naturalWidth: width, naturalHeight: height } = image;
      // Current iPhone camera modes can exceed the worker's 24 MP JPEG
      // compression budget. The browser has already decoded this preview;
      // allow one bounded camera image at a time and downscale its derivative.
      if (!width || !height || width * height > 50_000_000 || Math.max(width, height) > 16384) {
        finish(undefined, new Error("HEIC image exceeds the safe decoding limit (50 megapixels / 16384px edge)"));
        return;
      }
      const scale = Math.min(1, 2560 / Math.max(width, height));
      let canvas: HTMLCanvasElement;
      try {
        canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext("2d");
        if (!context) {
          finish({ blob, changed: false, reason: "canvas-unavailable" });
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
      } catch {
        finish({ blob, changed: false, reason: "codec-failed" });
        return;
      }
      progress("encoding");
      try {
        canvas.toBlob((jpeg) => {
          if (!jpeg || jpeg.type !== "image/jpeg") {
            finish({ blob, changed: false, reason: "encoder-unavailable" });
            return;
          }
          finish({ blob: jpeg, changed: true, reason: "transcoded" });
        }, "image/jpeg", 0.88);
      } catch {
        finish({ blob, changed: false, reason: "encoder-unavailable" });
      }
    };
    try { image.src = url; }
    catch { finish({ blob, changed: false, reason: "codec-unavailable" }); }
  });
}

export const processBrowserImage: ImageProcessor = (blob, signal, progress) => {
  if (isHeic(blob.type)) return transcodeHeic(blob, signal, progress);
  if (typeof Worker === "undefined")
    return Promise.resolve({
      blob,
      changed: false,
      reason: "worker-unavailable",
    });
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./image.worker.ts", import.meta.url), {
      type: "module",
    });
    const finish = (result?: ImageResult, error?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () =>
      finish(
        undefined,
        new DOMException("Image processing cancelled", "AbortError"),
      );
    const timer = setTimeout(
      () => finish({ blob, changed: false, reason: "timeout" }),
      20_000,
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    worker.onmessage = ({
      data,
    }: MessageEvent<{
      stage?: ImageStage;
      result?: ImageResult;
      error?: string;
    }>) => {
      if (data.stage) progress(data.stage);
      else if (data.error) finish(undefined, new Error(data.error));
      else if (data.result) finish(data.result);
    };
    worker.onerror = () =>
      finish({ blob, changed: false, reason: "codec-unavailable" });
    worker.postMessage(blob);
  });
};
