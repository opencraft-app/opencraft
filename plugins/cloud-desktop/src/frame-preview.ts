import type { DesktopFramePreview } from "./contract";

export function validFramePreview(value: DesktopFramePreview | null | undefined): value is DesktopFramePreview {
  return Boolean(value && Number.isFinite(value.aspectRatio) && value.aspectRatio > 0
    && typeof value.dataUrl === "string" && value.dataUrl.length <= 2_000_000
    && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.dataUrl));
}

/** Capture backing pixels, never scaled DOM or cursor overlays. No persistence. */
export function captureFramePreview(canvas: HTMLCanvasElement): DesktopFramePreview | null {
  if (!(canvas.width > 0 && canvas.height > 0)) return null;
  try {
    const scale = Math.min(1, 1280 / Math.max(canvas.width, canvas.height));
    const copy = canvas.ownerDocument.createElement("canvas");
    copy.width = Math.max(1, Math.round(canvas.width * scale));
    copy.height = Math.max(1, Math.round(canvas.height * scale));
    const context = copy.getContext("2d");
    if (!context) return null;
    context.drawImage(canvas, 0, 0, copy.width, copy.height);
    const preview = { dataUrl: copy.toDataURL("image/jpeg", .85), aspectRatio: canvas.width / canvas.height };
    return validFramePreview(preview) ? Object.freeze(preview) : null;
  } catch { return null; } // Tainted/unsupported capture cannot break viewing.
}
