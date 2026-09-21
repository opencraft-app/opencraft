import type { ImageProcessor, ImageStage, ImageResult } from "./service";

export const processBrowserImage: ImageProcessor = (blob, signal, progress) => {
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
