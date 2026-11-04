import { supportsH264MediaSource } from './h264-media-source';

export type BrowserVideoDecoder = 'webcodecs' | 'mse';
export const browserH264Config: Readonly<VideoDecoderConfig> = Object.freeze({ codec: 'avc1.42E028', optimizeForLatency: true });

/** Admission uses the exact configuration later passed to the decoder. */
export async function selectBrowserVideoDecoder(signal?: AbortSignal): Promise<BrowserVideoDecoder | null> {
  signal?.throwIfAborted();
  if (typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined'
    && typeof VideoDecoder.isConfigSupported === 'function') {
    const supported = await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (value: boolean, aborted = false) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (aborted) reject(signal!.reason); else resolve(value);
      };
      const abort = () => finish(false, true);
      const timer = setTimeout(() => finish(false), 2000);
      signal?.addEventListener('abort', abort, { once: true });
      void Promise.resolve().then(() => VideoDecoder.isConfigSupported(browserH264Config))
        .then(result => finish(result.supported === true), () => finish(false));
    });
    signal?.throwIfAborted();
    if (supported) return 'webcodecs';
  }
  signal?.throwIfAborted();
  try { return supportsH264MediaSource() ? 'mse' : null; }
  catch { return null; }
}
