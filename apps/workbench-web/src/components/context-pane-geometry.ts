export interface ContextPaneGeometry {
  readonly committedWidth: number;
  readonly frameWidth: number;
  readonly viewportWidth: number;
}

function validWidth(width: number): number {
  if (!Number.isFinite(width) || width < 0) throw new RangeError("Context width must be finite and non-negative");
  return width;
}

export function settledContextGeometry(width: number): ContextPaneGeometry {
  validWidth(width);
  return { committedWidth: width, frameWidth: width, viewportWidth: width };
}

/** Direct manipulation reflows both ways. The saved preference is not a layout constraint. */
export function previewContextGeometry(state: ContextPaneGeometry, width: number): ContextPaneGeometry {
  validWidth(width);
  return { ...state, frameWidth: width, viewportWidth: width };
}
