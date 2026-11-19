import { screenshotCrop, type ScreenshotRegion } from "./screenshot-geometry";
self.onmessage = async (event: MessageEvent<{ blob: Blob; region: ScreenshotRegion }>) => {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(event.data.blob);
    const r = screenshotCrop(event.data.region, bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(r.width, r.height),
      context = canvas.getContext("2d");
    if (!context) throw Error("Screenshot canvas unavailable");
    context.drawImage(bitmap, r.x, r.y, r.w, r.h, 0, 0, r.width, r.height);
    let blob: Blob | null = null;
    for (const quality of [0.8, 0.6, 0.45]) {
      const candidate = await canvas.convertToBlob({ type: "image/jpeg", quality });
      if (candidate.size <= 220 * 1024) {
        blob = candidate;
        break;
      }
    }
    self.postMessage({ blob });
  } catch {
    self.postMessage({ error: true });
  } finally {
    bitmap?.close();
  }
};
