import { screenshotCrop, type ScreenshotRegion } from './screenshot-geometry';
import { BROWSER_ANNOTATION_SCREENSHOT_LIMIT } from '@opencraft/browser-annotation';
async function fallback(blob: Blob, region: ScreenshotRegion): Promise<Blob | null> {
  const url = URL.createObjectURL(blob), image = new Image();
  try {
    image.src = url; await image.decode();
    const r = screenshotCrop(region, image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas'); canvas.width = r.width; canvas.height = r.height;
    const context = canvas.getContext('2d'); if (!context) return null;
    context.drawImage(image, r.x, r.y, r.w, r.h, 0, 0, r.width, r.height);
    for (const quality of [0.8, 0.6, 0.45]) {
      const result = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (result && result.size <= 220 * 1024) return result;
    }
    return null;
  } finally { URL.revokeObjectURL(url); }
}
export async function cropAnnotationScreenshot(dataUrl: string, region: ScreenshotRegion, signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted();
  const source = await (await fetch(dataUrl, { signal })).blob();
  let result: Blob | null;
  if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
    try {
      result = await new Promise<Blob | null>((resolve, reject) => {
        const worker = new Worker(new URL('./screenshot.worker.ts', import.meta.url), { type: 'module' });
        const done = (error?: Error, blob?: Blob | null) => { clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate(); error ? reject(error) : resolve(blob ?? null); };
        const abort = () => done(new Error('Screenshot cancelled'));
        const timer = setTimeout(() => done(new Error('Screenshot timed out')), 10000);
        worker.onmessage = event => event.data.error ? done(new Error('Screenshot failed')) : done(undefined, event.data.blob);
        worker.onerror = () => done(new Error('Screenshot worker unavailable'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        worker.postMessage({ blob: source, region });
      });
    } catch { signal.throwIfAborted(); result = await fallback(source, region); }
  } else result = await fallback(source, region);
  signal.throwIfAborted();
  if (!result) return null;
  const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(result); });
  signal.throwIfAborted();
  return data.length <= BROWSER_ANNOTATION_SCREENSHOT_LIMIT ? data : null;
}
