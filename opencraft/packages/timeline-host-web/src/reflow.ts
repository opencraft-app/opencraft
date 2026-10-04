const CODEX_REFLOW_PRESERVATION_MS = 250;

export interface TimelineReflowPreservationOptions {
  readonly durationMs?: number;
  readonly turnSelector?: string;
  readonly zoomScale?: number;
}

export interface TimelineReflowLease {
  /** Finish only after the disclosure's final layout has been committed. */
  complete(): void;
  /** Cancel immediately when input, replacement or unmount supersedes it. */
  cancel(): void;
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
export function beginTimelineElementReflow(
  element: HTMLElement,
  scrollElement: HTMLElement,
  options: Pick<TimelineReflowPreservationOptions, "turnSelector" | "zoomScale"> = {},
): TimelineReflowLease {
  const initialTop = element.getBoundingClientRect().top;
  const zoomScale = Number.isFinite(options.zoomScale) && (options.zoomScale ?? 0) > 0
    ? options.zoomScale!
    : 1;
  let frame: number | null = null;
  let disposed = false;
  let completing = false;
  let layoutRevision = 0;
  let settledRevision = -1;
  let settledFrames = 0;

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
      if (!element.isConnected || !scrollElement.isConnected) {
        dispose();
        return;
      }
      adjust();
      if (completing) {
        settledFrames = settledRevision === layoutRevision ? settledFrames + 1 : 0;
        settledRevision = layoutRevision;
        if (settledFrames >= 2) {
          dispose();
          return;
        }
      }
      schedule();
    });
  };
  const handleResize = () => {
    layoutRevision += 1;
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

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    observer?.disconnect();
  };
  return {
    complete: () => {
      if (disposed || completing) return;
      completing = true;
      // A synchronous collapse may commit after this frame's RAF callbacks.
      // Compensate in its layout completion, before the first collapsed paint.
      adjust();
      schedule();
    },
    cancel: dispose,
  };
}

/** Legacy expanders without an animation lifecycle retain their bounded policy. */
export function preserveTimelineElementPositionOnReflow(
  element: HTMLElement,
  scrollElement: HTMLElement,
  options: TimelineReflowPreservationOptions = {},
): () => void {
  const lease = beginTimelineElementReflow(element, scrollElement, options);
  const timeout = window.setTimeout(
    lease.complete,
    Math.max(0, options.durationMs ?? CODEX_REFLOW_PRESERVATION_MS),
  );
  return () => {
    window.clearTimeout(timeout);
    lease.cancel();
  };
}
