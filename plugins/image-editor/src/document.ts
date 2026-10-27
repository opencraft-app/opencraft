import { stickers, type Sticker } from "./stickers";
export interface Point { readonly x: number; readonly y: number }
export interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
/** Resolved native text presentation, retained with the local annotation pixels. */
export interface ImageTextFormat { readonly family: string; readonly weight: string; readonly leading: number }
export type ImageEdit =
  | { readonly type: "pen" | "mosaic"; readonly points: readonly Point[]; readonly width: number; readonly color: string }
  | { readonly type: "text"; readonly point: Point; readonly text: string; readonly size: number; readonly color: string; readonly format?: ImageTextFormat }
  | { readonly type: "sticker"; readonly point: Point; readonly sticker: Sticker; readonly size: number }
  | { readonly type: "crop"; readonly rect: Rect }
  | { readonly type: "rotate" };
export interface EditHistory { readonly edits: readonly ImageEdit[]; readonly cursor: number }
export const emptyHistory: EditHistory = { edits: [], cursor: 0 };
export function commitEdit(history: EditHistory, edit: ImageEdit): EditHistory {
  return { edits: [...history.edits.slice(0, history.cursor), edit], cursor: history.cursor + 1 };
}
export function stepHistory(history: EditHistory, direction: -1 | 1): EditHistory {
  return { ...history, cursor: Math.max(0, Math.min(history.edits.length, history.cursor + direction)) };
}
export function selectionRect(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}
function canvas(width: number, height: number): HTMLCanvasElement {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width * height > 32_000_000 || width > 16384 || height > 16384) throw new Error("Image exceeds editor canvas capacity");
  const result = document.createElement("canvas");
  result.width = Math.max(1, Math.round(width)); result.height = Math.max(1, Math.round(height));
  return result;
}
function context(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const result = target.getContext("2d");
  if (!result) throw new Error("Canvas unavailable");
  return result;
}
function stroke(ctx: CanvasRenderingContext2D, points: readonly Point[], width: number, color: string): void {
  const first = points[0];
  if (!first) return;
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width; ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (points.length === 1) { ctx.beginPath(); ctx.arc(first.x, first.y, width / 2, 0, Math.PI * 2); ctx.fill(); return; }
  ctx.beginPath(); ctx.moveTo(first.x, first.y);
  for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.stroke();
}

/** Replays operations from immutable source pixels; history contains no raster snapshots. */
export function renderDocument(image: HTMLImageElement, history: EditHistory): HTMLCanvasElement {
  let result = canvas(image.naturalWidth, image.naturalHeight);
  context(result).drawImage(image, 0, 0);
  for (const edit of history.edits.slice(0, history.cursor)) {
    if (edit.type === "crop") {
      const x = Math.max(0, Math.min(result.width - 1, Math.round(edit.rect.x)));
      const y = Math.max(0, Math.min(result.height - 1, Math.round(edit.rect.y)));
      const cropped = canvas(Math.min(result.width - x, edit.rect.width), Math.min(result.height - y, edit.rect.height));
      context(cropped).drawImage(result, x, y, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
      result = cropped;
    } else if (edit.type === "rotate") {
      const rotated = canvas(result.height, result.width), ctx = context(rotated);
      ctx.translate(rotated.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(result, 0, 0); result = rotated;
    } else paintEdit(result, edit);
  }
  return result;
}

export function paintEdit(target: HTMLCanvasElement, edit: Exclude<ImageEdit, { type: "crop" | "rotate" }>): void {
  const ctx = context(target);
  if (edit.type === "pen") { stroke(ctx, edit.points, edit.width, edit.color); return; }
  if (edit.type === "sticker") {
    ctx.save(); ctx.translate(edit.point.x - edit.size / 2, edit.point.y - edit.size / 2); ctx.scale(edit.size / 32, edit.size / 32);
    for (const layer of stickers[edit.sticker]) { ctx.fillStyle = layer.color; ctx.fill(new Path2D(layer.path)); }
    ctx.restore(); return;
  }
  if (edit.type === "text") {
    ctx.font = `${edit.format?.weight ?? "600"} ${edit.size}px ${edit.format?.family ?? "sans-serif"}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.lineJoin = "round"; ctx.lineWidth = Math.max(2, edit.size / 16); ctx.strokeStyle = "#000000"; ctx.fillStyle = edit.color;
    const lines = edit.text.split("\n");
    lines.forEach((line, index) => { const y = edit.point.y + (index - (lines.length - 1) / 2) * edit.size * (edit.format?.leading ?? 1.2); ctx.strokeText(line, edit.point.x, y); ctx.fillText(line, edit.point.x, y); });
    return;
  }
  // Pixelate current pixels, then clip to the selected brush stroke. No original
  // image is retained in the exported file or sent as a second attachment.
  const block = Math.max(8, Math.round(edit.width / 3));
  const small = canvas(Math.ceil(target.width / block), Math.ceil(target.height / block));
  context(small).drawImage(target, 0, 0, small.width, small.height);
  const layer = canvas(target.width, target.height), layerContext = context(layer);
  layerContext.imageSmoothingEnabled = false; layerContext.drawImage(small, 0, 0, layer.width, layer.height);
  const mask = canvas(target.width, target.height);
  stroke(context(mask), edit.points, edit.width, "#ffffff");
  layerContext.globalCompositeOperation = "destination-in"; layerContext.drawImage(mask, 0, 0);
  ctx.drawImage(layer, 0, 0);
}

export function exportImage(target: HTMLCanvasElement, name: string): Promise<File> {
  return new Promise((resolve, reject) => target.toBlob(blob => {
    if (!blob) { reject(new Error("Image export failed")); return; }
    resolve(new File([blob], `${name.replace(/\.[^.]+$/u, "")}-edited.png`, { type: "image/png" }));
  }, "image/png"));
}
