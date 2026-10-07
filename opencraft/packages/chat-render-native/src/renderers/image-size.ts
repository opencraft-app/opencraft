export interface NativeImageBox {
  readonly width: number;
  readonly height: number;
}

/** Web thumbnails use their natural aspect ratio within a 200px square. */
export function nativeImageBox(
  sourceWidth: number | null,
  sourceHeight: number | null,
  containerWidth: number | null,
): NativeImageBox {
  const maxWidth = Math.min(200, containerWidth !== null && Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : 200);
  if (sourceWidth === null || sourceHeight === null
    || !Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)
    || sourceWidth <= 0 || sourceHeight <= 0) {
    return { width: maxWidth, height: 96 };
  }
  const scale = Math.min(1, maxWidth / sourceWidth, 200 / sourceHeight);
  return { width: sourceWidth * scale, height: sourceHeight * scale };
}
