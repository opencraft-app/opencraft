import { recordTimelineDiagnostic, subscribeTimelineDiagnostics, timelineDiagnosticId, timelineDiagnosticsEnabled } from "./diagnostics";

interface FrameGeometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly width: number;
  readonly height: number;
  readonly anchor: { readonly id: number; readonly top: number; readonly kind: "text" | "block" } | null;
  readonly readCostMs: number;
}

/** Read-only ports. No scroll/controller writes, text content or conversation IDs. */
export interface ScrollFrameDiagnosticPort {
  readonly viewport: number;
  readonly now: () => number;
  readonly requestFrame: (callback: FrameRequestCallback) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly read: () => FrameGeometry | null;
  readonly reset: () => void;
  readonly subscribeActivity: (wake: (scrollEvent?: boolean) => void) => () => void;
}

/** Opt-in, activity-bounded sampling; listeners and frames do not exist while off. */
export function observeScrollFrameDiagnostics(port: ScrollFrameDiagnosticPort): () => void {
  let active = false, disposed = false, generation = 0;
  let frame: number | null = null;
  let unlisten: (() => void) | undefined;
  let previous: (FrameGeometry & { at: number }) | null = null;
  let activityAt = 0, lastRecordAt = -Infinity, lastScrollAt: number | null = null;
  let scrollEvents = 0, windowFrames = 0, maxFrameMs = 0;
  const clear = () => {
    generation++;
    if (frame !== null) port.cancelFrame(frame);
    frame = null; previous = null;
    lastRecordAt = -Infinity; lastScrollAt = null;
    scrollEvents = 0; windowFrames = 0; maxFrameMs = 0;
    port.reset();
  };
  const schedule = () => {
    if (!active || frame !== null) return;
    const lease = generation;
    frame = port.requestFrame(at => {
      if (lease !== generation || !active || !timelineDiagnosticsEnabled()) return;
      frame = null;
      try {
        const current = port.read();
        if (current === null) { clear(); return; }
        const frameMs = previous === null ? null : Math.max(0, at - previous.at);
        const scrollDelta = previous === null ? null : current.scrollTop - previous.scrollTop;
        const sameViewport = previous !== null && previous.width === current.width && previous.height === current.height;
        const sameAnchor = sameViewport && current.anchor !== null && previous?.anchor?.id === current.anchor.id;
        const textDelta = sameAnchor ? current.anchor!.top - previous!.anchor!.top : null;
        // column-reverse: physical movement moves the text by -scrollDelta.
        const layoutDelta = textDelta === null || scrollDelta === null ? null : textDelta + scrollDelta;
        const frameGap = frameMs !== null && frameMs > 50;
        const textShift = layoutDelta !== null && Math.abs(layoutDelta) > 2;
        const largeStep = scrollDelta !== null && Math.abs(scrollDelta) > Math.max(120, current.height * .75);
        windowFrames++; maxFrameMs = Math.max(maxFrameMs, frameMs ?? 0);
        if (previous === null || at - lastRecordAt >= 50 || frameGap || textShift || largeStep) {
          recordTimelineDiagnostic("scroll-frame", {
            viewport: port.viewport, frameAtMs: at, frameMs, windowFrames, maxFrameMs,
            scrollTop: current.scrollTop, scrollDelta, scrollHeight: current.scrollHeight,
            heightDelta: previous === null ? null : current.scrollHeight - previous.scrollHeight,
            viewportWidth: current.width, viewportHeight: current.height,
            anchor: current.anchor?.id ?? null, anchorKind: current.anchor?.kind ?? null,
            anchorTop: current.anchor?.top ?? null, sameAnchor, textDelta, layoutDelta,
            frameGap, textShift, largeStep, scrollEvents,
            sinceScrollEventMs: lastScrollAt === null ? null : Math.max(0, at - lastScrollAt),
            readCostMs: current.readCostMs,
          });
          lastRecordAt = at; windowFrames = 0; maxFrameMs = 0; scrollEvents = 0;
        }
        // A sink may turn recording off synchronously. Never revive that lease.
        if (lease !== generation || !active || !timelineDiagnosticsEnabled()) return;
        if ((scrollDelta !== 0 && scrollDelta !== null) || textShift || previous?.scrollHeight !== current.scrollHeight) activityAt = at;
        previous = { ...current, at };
        if (at - activityAt < 250) schedule();
        else clear();
      } catch { clear(); } // A diagnostic geometry failure cannot affect scrolling.
    });
  };
  const wake = (scrollEvent = false) => {
    if (!active || !timelineDiagnosticsEnabled()) return;
    activityAt = port.now();
    if (scrollEvent) { lastScrollAt = activityAt; scrollEvents++; }
    schedule();
  };
  const update = () => {
    if (disposed) return;
    active = timelineDiagnosticsEnabled();
    unlisten?.(); unlisten = undefined;
    clear();
    if (active) { unlisten = port.subscribeActivity(wake); wake(); }
  };
  const unsubscribe = subscribeTimelineDiagnostics(update);
  update();
  return () => { disposed = true; active = false; unsubscribe(); unlisten?.(); clear(); };
}

/** Owned by the existing viewport; no document-wide observer or paragraph scan. */
export function observeWebScrollFrames(root: HTMLDivElement, owner: object, isCurrent: () => boolean): () => void {
  let anchor: { target: Range | HTMLElement; node: Node; kind: "text" | "block" } | null = null;
  const pick = (bounds: DOMRect) => {
    const doc = root.ownerDocument, view = doc.defaultView!;
    const caretDocument = doc as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const x = Math.max(1, Math.min(view.innerWidth - 1, bounds.left + bounds.width * .4));
    for (const fraction of [.4, .6, .25]) {
      const y = Math.max(1, Math.min(view.innerHeight - 1, bounds.top + bounds.height * fraction));
      let range = caretDocument.caretRangeFromPoint?.(x, y) ?? null;
      if (range === null) {
        const position = caretDocument.caretPositionFromPoint?.(x, y);
        if (position) { range = doc.createRange(); range.setStart(position.offsetNode, position.offset); range.collapse(true); }
      }
      if (range && range.startContainer.nodeType === 3 && root.contains(range.startContainer)
        && range.startContainer.parentElement?.closest("[data-virtualized-turn-key]")) {
        const text = range.startContainer as Text;
        if (range.startOffset < text.length) range.setEnd(text, range.startOffset + 1);
        const rect = range.getBoundingClientRect();
        if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom) {
          return { target: range, node: text, kind: "text" as const };
        }
      }
      const block = doc.elementFromPoint(x, y)?.closest<HTMLElement>("p, pre, li, h1, h2, h3, h4, h5, h6");
      if (block && root.contains(block) && block.closest("[data-virtualized-turn-key]")) {
        return { target: block, node: block, kind: "block" as const };
      }
    }
    return null;
  };
  return observeScrollFrameDiagnostics({
    viewport: timelineDiagnosticId(owner), now: () => root.ownerDocument.defaultView!.performance.now(),
    requestFrame: callback => root.ownerDocument.defaultView!.requestAnimationFrame(callback),
    cancelFrame: handle => root.ownerDocument.defaultView!.cancelAnimationFrame(handle),
    reset: () => { anchor = null; },
    read: () => {
      const doc = root.ownerDocument, view = doc.defaultView!;
      const started = view.performance.now();
      if (!isCurrent() || !root.isConnected || doc.visibilityState === "hidden" || root.clientHeight === 0) return null;
      const bounds = root.getBoundingClientRect();
      if (Math.abs(bounds.height - root.clientHeight) > 1) return null;
      if (anchor && !root.contains(anchor.node)) anchor = null;
      anchor ??= pick(bounds);
      const rect = anchor?.target.getBoundingClientRect();
      const point = anchor && rect && rect.height > 0
        ? { id: timelineDiagnosticId(anchor.target), top: rect.top - bounds.top, kind: anchor.kind } : null;
      // Measure the outgoing point once before selecting another. A jump which
      // pushes it offscreen must not silently become an unrelated new anchor.
      if (!rect || rect.height === 0 || rect.bottom <= bounds.top || rect.top >= bounds.bottom) anchor = null;
      return { scrollTop: root.scrollTop, scrollHeight: root.scrollHeight,
        width: root.clientWidth, height: root.clientHeight, anchor: point,
        readCostMs: view.performance.now() - started };
    },
    subscribeActivity: wake => {
      const doc = root.ownerDocument;
      const scroll = () => wake(true), input = () => wake();
      root.addEventListener("scroll", scroll, { passive: true });
      const inputs = ["touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "wheel"];
      for (const type of inputs) root.addEventListener(type, input, { passive: true });
      doc.addEventListener("visibilitychange", input);
      return () => {
        root.removeEventListener("scroll", scroll);
        for (const type of inputs) root.removeEventListener(type, input);
        doc.removeEventListener("visibilitychange", input);
      };
    },
  });
}
