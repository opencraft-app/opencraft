const DEFAULT_MIN_THUMB_SIZE = 36;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export interface VerticalScrollbarGeometryInput {
  viewportSize: number;
  contentSize: number;
  offset: number;
  minThumbSize?: number;
}

export interface VerticalScrollbarGeometry {
  visible: boolean;
  maxScrollOffset: number;
  thumbSize: number;
  thumbOffset: number;
  maxThumbOffset: number;
}

export function computeVerticalScrollbarGeometry(
  input: VerticalScrollbarGeometryInput,
): VerticalScrollbarGeometry {
  const viewportSize = finiteNonNegative(input.viewportSize);
  const contentSize = finiteNonNegative(input.contentSize);
  const minThumbSize = Number.isFinite(input.minThumbSize)
    ? Math.max(0, input.minThumbSize ?? DEFAULT_MIN_THUMB_SIZE)
    : DEFAULT_MIN_THUMB_SIZE;

  const maxScrollOffset = Math.max(0, contentSize - viewportSize);
  if (viewportSize <= 0 || contentSize <= 0 || maxScrollOffset <= 0) {
    return {
      maxScrollOffset: 0,
      maxThumbOffset: 0,
      thumbOffset: 0,
      thumbSize: 0,
      visible: false,
    };
  }

  const rawThumbSize = (viewportSize * viewportSize) / contentSize;
  const thumbSize = clamp(rawThumbSize, minThumbSize, viewportSize);
  const maxThumbOffset = Math.max(0, viewportSize - thumbSize);
  const clampedOffset = clamp(input.offset, 0, maxScrollOffset);
  const thumbOffset =
    maxScrollOffset > 0 ? (clampedOffset / maxScrollOffset) * maxThumbOffset : 0;

  return {
    maxScrollOffset,
    maxThumbOffset,
    thumbOffset,
    thumbSize,
    visible: true,
  };
}

export interface ScrollOffsetFromThumbDeltaInput {
  startOffset: number;
  delta: number;
  maxScrollOffset: number;
  maxThumbOffset: number;
}

export function computeScrollOffsetFromThumbDelta(
  input: ScrollOffsetFromThumbDeltaInput,
): number {
  const maxScrollOffset = finiteNonNegative(input.maxScrollOffset);
  const maxThumbOffset = finiteNonNegative(input.maxThumbOffset);
  const startOffset = clamp(input.startOffset, 0, maxScrollOffset);
  if (maxScrollOffset <= 0 || maxThumbOffset <= 0) {
    return startOffset;
  }

  const scrollPerPixel = maxScrollOffset / maxThumbOffset;
  return clamp(startOffset + input.delta * scrollPerPixel, 0, maxScrollOffset);
}

export interface ScrollOffsetFromThumbOffsetInput {
  thumbOffset: number;
  maxScrollOffset: number;
  maxThumbOffset: number;
}

export function computeScrollOffsetFromThumbOffset(
  input: ScrollOffsetFromThumbOffsetInput,
): number {
  const maxScrollOffset = finiteNonNegative(input.maxScrollOffset);
  const maxThumbOffset = finiteNonNegative(input.maxThumbOffset);
  if (maxScrollOffset <= 0 || maxThumbOffset <= 0) {
    return 0;
  }

  const scrollPerPixel = maxScrollOffset / maxThumbOffset;
  return clamp(input.thumbOffset * scrollPerPixel, 0, maxScrollOffset);
}
