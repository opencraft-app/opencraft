export type Point = { x: number; y: number };
export type ImageTransform = Point & { scale: number; rotation: number };
export type ViewportGeometry = { width: number; height: number; viewportWidth: number; viewportHeight: number };

/** All input devices use the same anchor and rotated-content bounds. */
export function transformImage(start: ImageTransform, from: Point, to: Point,
  requestedScale: number, delta: number, geometry: ViewportGeometry): ImageTransform {
  if (![requestedScale, delta, from.x, from.y, to.x, to.y].every(Number.isFinite)) return start;
  const scale = Math.min(5, Math.max(0.2, requestedScale));
  const rotation = start.rotation + delta;
  const ratio = scale / start.scale, c = Math.cos(delta), s = Math.sin(delta);
  const anchorX = from.x - start.x, anchorY = from.y - start.y;
  const cosine = Math.abs(Math.cos(rotation)), sine = Math.abs(Math.sin(rotation));
  const limitX = Math.max(0, ((cosine * geometry.width + sine * geometry.height) * scale - geometry.viewportWidth) / 2);
  const limitY = Math.max(0, ((sine * geometry.width + cosine * geometry.height) * scale - geometry.viewportHeight) / 2);
  const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
  return { scale, rotation,
    x: clamp(to.x - (c * anchorX - s * anchorY) * ratio, limitX),
    y: clamp(to.y - (s * anchorX + c * anchorY) * ratio, limitY) };
}

export function wheelPixels(delta: number, mode: number, viewportSize: number): number {
  return delta * (mode === 1 ? 16 : mode === 2 ? viewportSize : 1);
}
