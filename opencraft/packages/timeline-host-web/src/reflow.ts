const CODEX_REFLOW_PRESERVATION_MS = 250;

export interface TimelineReflowPreservationOptions {
  readonly durationMs?: number;
  readonly turnSelector?: string;
  readonly zoomScale?: number;
}

export function timelineReflowScrollAdjustment(
  initialElementTopPx: number,
  nextElementTopPx: number,
  zoomScale = 1,
): number {
  const scale = Number.isFinite(zoomScale) && zoomScale > 0 ? zoomScale : 1;
  return (nextElementTopPx - initialElementTopPx) / scale;
}

/**
 * Pin an interacted element to its visual Y position while an expandable
 * timeline block reflows. This is the source-faithful complement to the
 * virtualizer's distance-from-bottom transaction: the transaction stabilizes
 * the viewport, while this adapter stabilizes the user's local interaction
 * anchor through an animated disclosure.
 */
export function preserveTimelineElementPositionOnReflow(
  element: HTMLElement,
  scrollElement: HTMLElement,
  options: TimelineReflowPreservationOptions = {},
): () => void {
  const initialTop = element.getBoundingClientRect().top;
  const zoomScale = Number.isFinite(options.zoomScale) && (options.zoomScale ?? 0) > 0
    ? options.zoomScale!
    : 1;
  const durationMs = Math.max(0, options.durationMs ?? CODEX_REFLOW_PRESERVATION_MS);
  let frame: number | null = null;
  let disposed = false;

  const adjust = () => {
    if (disposed || !element.isConnected || !scrollElement.isConnected) return;
    scrollElement.scrollTop += timelineReflowScrollAdjustment(
      initialTop,
      element.getBoundingClientRect().top,
      zoomScale,
    );
  };
  const schedule = () => {
    if (frame !== null || disposed) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      adjust();
    });
  };
  const handleResize = () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    adjust();
    schedule();
  };

  const turn = element.closest(options.turnSelector ?? "[data-turn-key]");
  const observer = turn === null || typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver(handleResize);
  if (turn !== null) observer?.observe(turn);
  schedule();

  let timeout: number | null = null;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timeout !== null) window.clearTimeout(timeout);
    timeout = null;
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    observer?.disconnect();
  };
  timeout = window.setTimeout(dispose, durationMs);
  return dispose;
}
