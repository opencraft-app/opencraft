

function resizeAxis(origin, movement, direction, scale, available, minimum) {
  if (direction === 0) return origin;
  const fitLimit = available > 0 ? available / scale : 4096;
  const requested = origin + direction * movement / scale;
  return Math.round(Math.max(minimum, Math.min(requested, fitLimit, 4096)));
}

export function computeDragResizeDimensions({ drag, fitHeight, fitWidth, pointerX, pointerY, scale }) {
  let horizontal = 2;
  let vertical = 0;
  switch (drag.edge) {
    case "left": horizontal = -2; break;
    case "bottom": horizontal = 0; vertical = 1; break;
    case "bottom-left": horizontal = -2; vertical = 1; break;
    case "bottom-right": vertical = 1; break;
  }
  return {
    width: resizeAxis(drag.startWidth, pointerX - drag.startPointerX,
      horizontal, scale, fitWidth, 240),
    height: resizeAxis(drag.startHeight, pointerY - drag.startPointerY,
      vertical, scale, fitHeight, 160),
  };
}
