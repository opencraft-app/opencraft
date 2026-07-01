export interface SessionDragPreviewPoint {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
}

export const SESSION_DRAG_PREVIEW_THRESHOLD_PX = 8;

export function shouldStartSessionDragPreview(
  start: SessionDragPreviewPoint,
  current: SessionDragPreviewPoint,
  thresholdPx = SESSION_DRAG_PREVIEW_THRESHOLD_PX,
) {
  return Math.hypot(
    current.clientX - start.clientX,
    current.clientY - start.clientY,
  ) >= thresholdPx;
}
