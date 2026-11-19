export interface ScreenshotRegion {
  top: number;
  bottom: number;
  left?: number;
  right?: number;
}
/** Never fall back to a whole viewport when the target geometry is unavailable. */
export function screenshotCrop(region: ScreenshotRegion, width: number, height: number) {
  const { top, bottom, left, right } = region;
  if (
    ![top, bottom, left, right, width, height].every((v) => typeof v === "number" && Number.isFinite(v)) ||
    width <= 0 ||
    height <= 0 ||
    left! < 0 ||
    top < 0 ||
    right! > 1 ||
    bottom > 1 ||
    right! <= left! ||
    bottom <= top
  )
    throw Error("Target is not visible");
  const x = Math.ceil(left! * width),
    y = Math.ceil(top * height);
  const w = Math.floor(right! * width) - x,
    h = Math.floor(bottom * height) - y;
  if (w < 1 || h < 1) throw Error("Target is not visible");
  const scale = Math.min(1, 1024 / w, 1024 / h);
  return { x, y, w, h, width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}
