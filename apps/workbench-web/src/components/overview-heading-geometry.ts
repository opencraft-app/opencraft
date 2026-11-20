export interface HeadingRect { x: number; y: number; width: number; height: number }

/** Measured once in normal card layout. Ink excludes padding and inert hit areas. */
export interface OverviewHeadingMetrics {
  rect: HeadingRect;
  inkTop: number;
  inkBottom: number;
  bandHeight: number;
  frameWidth: number;
}
export interface OverviewHeadingGeometry {
  rect: HeadingRect;
  opacity: number;
}

/** The content aperture allocates the title band. Keep the complete ink centered
 * in that band as it forms; the heading's transparent hit box may extend beyond
 * it while inert. Waiting for that whole box delays text until the last frames. */
export function projectOverviewHeading(frame: HeadingRect, content: HeadingRect,
  metrics: OverviewHeadingMetrics, geometry: number): OverviewHeadingGeometry {
  const progress = Math.max(0, Math.min(1, geometry));
  const band = Math.max(0, content.y - frame.y);
  const inkHeight = metrics.inkBottom - metrics.inkTop;
  const inkCenter = (metrics.inkTop + metrics.inkBottom) / 2;
  const finalCenterOffset = metrics.rect.y + inkCenter - metrics.bandHeight / 2;
  const centerOffset = finalCenterOffset * progress;
  const available = band - 2 * Math.abs(centerOffset);
  const finalAvailable = metrics.bandHeight - 2 * Math.abs(finalCenterOffset);
  const room = Math.max(0, Math.min(1, (available - inkHeight) / Math.max(1, finalAvailable - inkHeight)));
  return {
    rect: { x: frame.x + metrics.rect.x * progress,
      y: frame.y + band / 2 - inkCenter + centerOffset,
      width: Math.max(0, frame.width - (metrics.frameWidth-metrics.rect.width)*progress), height: metrics.rect.height },
    opacity: room * room * (3 - 2 * room),
  };
}
