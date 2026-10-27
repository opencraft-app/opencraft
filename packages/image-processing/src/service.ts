import { Service, type Context } from "@deepseek-ai/cordis";

export type ImageStage = "queued" | "inspecting" | "decoding" | "encoding";
export interface ImageResult {
  blob: Blob;
  changed: boolean;
  reason: string;
}
export interface ImageOptions {
  signal?: AbortSignal;
  onProgress?: (stage: ImageStage) => void;
}
export type ImageProcessor = (
  blob: Blob,
  signal: AbortSignal,
  progress: (stage: ImageStage) => void,
) => Promise<ImageResult>;
declare module "@deepseek-ai/cordis" {
  interface Context {
    imageProcessing: ImageProcessingService;
  }
}
interface Job {
  controller: AbortController;
  start: () => Promise<void>;
  cancel: () => void;
}

/** CPU ownership is separate from downloads/cache. One active decode bounds memory. */
export class ImageProcessingService extends Service {
  private queue: Job[] = [];
  private active: Job | null = null;
  private closed = false;
  constructor(
    ctx: Context,
    private config: { process: ImageProcessor },
  ) {
    super(ctx, "imageProcessing");
    ctx.effect(() => () => {
      this.closed = true;
      this.active?.controller.abort();
      for (const job of [...this.queue]) job.cancel();
    });
  }
  compress(blob: Blob, options: ImageOptions = {}): Promise<ImageResult> {
    if (this.closed || options.signal?.aborted)
      return Promise.reject(
        new DOMException("Image processing cancelled", "AbortError"),
      );
    if (this.queue.length >= 16)
      return Promise.reject(new Error("Image processing queue is full"));
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const progress = (stage: ImageStage) => {
        try {
          options.onProgress?.(stage);
        } catch {
          /* observers cannot break work */
        }
      };
      const cleanup = () =>
        options.signal?.removeEventListener("abort", job.cancel);
      const job: Job = {
        controller,
        cancel: () => {
          controller.abort();
          this.queue = this.queue.filter((value) => value !== job);
          cleanup();
          reject(new DOMException("Image processing cancelled", "AbortError"));
        },
        start: async () => {
          try {
            const result = await this.config.process(
              blob,
              controller.signal,
              progress,
            );
            controller.signal.throwIfAborted();
            // HEIC must become a supported transport image even when JPEG is
            // larger than the camera original; ordinary compression still
            // keeps the smaller of the two.
            const requiredTranscode = result.reason === "transcoded"
              && (blob.type === "image/heic" || blob.type === "image/heif")
              && result.blob.type === "image/jpeg";
            resolve(
              result.changed && (result.blob.size < blob.size || requiredTranscode)
                ? result
                : {
                    blob,
                    changed: false,
                    reason: result.changed ? "no-savings" : result.reason,
                  },
            );
          } catch (error) {
            reject(error);
          } finally {
            cleanup();
          }
        },
      };
      options.signal?.addEventListener("abort", job.cancel, { once: true });
      this.queue.push(job);
      progress("queued");
      this.drain();
    });
  }
  private drain() {
    if (this.closed || this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    void job.start().finally(() => {
      this.active = null;
      this.drain();
    });
  }
}
