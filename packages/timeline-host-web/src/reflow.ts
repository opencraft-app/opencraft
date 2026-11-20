import { recordTimelineDiagnostic, timelineDiagnosticsEnabled, timelineDiagnosticId } from "./diagnostics";
export const OPENCRAFT_REFLOW_PRESERVATION_MS = 250;

export interface TimelineReflowPreservationOptions {
  readonly durationMs?: number;
  readonly turnSelector?: string;
  readonly zoomScale?: number;
  readonly onPositionChanged?: () => void;
  readonly onFinish?: (reason: "settled" | "cancelled") => void;
}

export interface TimelineReflowLease {
  /** Stabilize current layout before the virtualizer selects its render window. */
  synchronize(): void;
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
 * timeline block reflows. This complements the
 * virtualizer's distance-from-bottom transaction: the transaction stabilizes
 * the viewport, while this adapter stabilizes the user's local interaction
 * anchor through an animated disclosure.
 */
export function beginTimelineElementReflow(
  element: HTMLElement,
  scrollElement: HTMLElement,
  options: TimelineReflowPreservationOptions = {},
): TimelineReflowLease {
  const initialTop = element.getBoundingClientRect().top;
  const zoomScale = Number.isFinite(options.zoomScale) && (options.zoomScale ?? 0) > 0
    ? options.zoomScale!
    : 1;
  let frame: number | null = null;
  let timer: number | null = null;
  let disposed = false;
  let completing = false;
  let layoutRevision = 0;
  let settledRevision = -1;
  let settledFrames = 0;

  const adjust = () => {
    if (disposed || !element.isConnected || !scrollElement.isConnected) return;
    const before = scrollElement.scrollTop;
    const correction = timelineReflowScrollAdjustment(
      initialTop,
      element.getBoundingClientRect().top,
      zoomScale,
    );
    if (Math.abs(correction) <= 0.01) return;
    scrollElement.scrollTop = before + correction;
    if (timelineDiagnosticsEnabled()) recordTimelineDiagnostic("scroll-write", {
      viewport: timelineDiagnosticId(scrollElement), reason: "reflow-anchor", before, after: scrollElement.scrollTop,
      delta: scrollElement.scrollTop - before, requested: before + correction,
    });
    if (scrollElement.scrollTop !== before) options.onPositionChanged?.();
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
          dispose("settled");
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

  const dispose = (reason: "settled" | "cancelled" = "cancelled") => {
    if (disposed) return;
    disposed = true;
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    observer?.disconnect();
    options.onFinish?.(reason);
  };
  const complete = () => {
    if (disposed || completing) return;
    completing = true;
    // A synchronous collapse may commit after this frame's RAF callbacks.
    // Compensate in its layout completion, before the first collapsed paint.
    adjust();
    schedule();
  };
  if (options.durationMs !== undefined) timer = window.setTimeout(
    complete, Math.max(0, options.durationMs),
  );
  return {
    synchronize: () => {
      if (!element.isConnected || !scrollElement.isConnected) dispose();
      else adjust();
    },
    complete,
    cancel: dispose,
  };
}

/** Legacy expanders without an animation lifecycle retain their bounded policy. */
export function preserveTimelineElementPositionOnReflow(
  element: HTMLElement,
  scrollElement: HTMLElement,
  options: TimelineReflowPreservationOptions = {},
): () => void {
  return beginTimelineElementReflow(element, scrollElement, {
    ...options, durationMs: options.durationMs ?? OPENCRAFT_REFLOW_PRESERVATION_MS,
  }).cancel;
}
