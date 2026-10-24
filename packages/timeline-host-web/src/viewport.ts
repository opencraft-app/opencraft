import {
  calculateSoftwareKeyboardInset,
  projectTimelineViewportLayout,
  resolveTimelineViewportPolicy,
  type TimelineRenderHostKind,
  type TimelineRenderPlatform,
  type TimelineViewportPolicy,
  type TimelineViewportPort,
  type TimelineViewportSnapshot,
} from "@opencraft/timeline-virtualizer";

interface WebTimelineViewportRoot {
  readonly dataset: DOMStringMap;
  readonly style: CSSStyleDeclaration;
}

export interface WebTimelineViewportOptions {
  readonly kind: Exclude<TimelineRenderHostKind, "native">;
  readonly platform: "darwin" | "win32" | "linux";
  /** Read-only evidence after each mobile geometry commit, including unchanged frames. */
  readonly onGeometryObserved?: (event?: Event) => void;
}

export function resolveWebTimelinePlatform({
  maxTouchPoints,
  navigatorPlatform,
  userAgent,
}: {
  readonly maxTouchPoints: number;
  readonly navigatorPlatform: string;
  readonly userAgent: string;
}): TimelineRenderPlatform {
  if (/Android/i.test(userAgent)) return "android";
  if (/iPad|iPhone|iPod/i.test(userAgent)) return "ios";
  if (/^Mac/i.test(navigatorPlatform) && maxTouchPoints > 1) return "ios";
  if (/Win/i.test(navigatorPlatform)) return "win32";
  if (/Mac/i.test(navigatorPlatform)) return "darwin";
  return "linux";
}

export function isEditableElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return element.isContentEditable
    || element.closest("input:not([type='button']):not([type='checkbox']):not([type='radio']), textarea, [contenteditable='true']") !== null;
}

export function createWebTimelineViewportSnapshot({
  editableFocused,
  layoutHeightPx,
  layoutWidthPx,
  revision,
  scale = 1,
  visualHeightPx = layoutHeightPx,
  visualOffsetLeftPx = 0,
  visualOffsetTopPx = 0,
  visualWidthPx = layoutWidthPx,
}: {
  readonly editableFocused: boolean;
  readonly layoutHeightPx: number;
  readonly layoutWidthPx: number;
  readonly revision: number;
  readonly scale?: number;
  readonly visualHeightPx?: number;
  readonly visualOffsetLeftPx?: number;
  readonly visualOffsetTopPx?: number;
  readonly visualWidthPx?: number;
}): TimelineViewportSnapshot {
  return {
    revision,
    layoutViewport: {
      widthPx: Math.max(0, layoutWidthPx),
      heightPx: Math.max(0, layoutHeightPx),
    },
    visualViewport: {
      widthPx: Math.max(0, visualWidthPx),
      heightPx: Math.max(0, visualHeightPx),
    },
    visualOffset: {
      leftPx: Math.max(0, visualOffsetLeftPx),
      topPx: Math.max(0, visualOffsetTopPx),
    },
    scale,
    keyboardInsetBottomPx: calculateSoftwareKeyboardInset({
      editableFocused,
      layoutViewportHeightPx: layoutHeightPx,
      scale,
      visualOffsetTopPx,
      visualViewportHeightPx: visualHeightPx,
    }),
    editableFocused,
  };
}

export function applyTimelineViewportDocumentState(
  root: WebTimelineViewportRoot,
  snapshot: TimelineViewportSnapshot,
  policy: TimelineViewportPolicy,
  fixedFrameOffset = snapshot.visualOffset,
): void {
  applyTimelineViewportDocumentExtent(root, snapshot, policy);
  applyTimelineViewportDocumentOrigin(root, snapshot, policy, fixedFrameOffset);
}

function setViewportProperty(root: WebTimelineViewportRoot, name: string, value: number): void {
  const cssValue = `${value}px`;
  if (root.style.getPropertyValue(name) !== cssValue) root.style.setProperty(name, cssValue);
}

function applyTimelineViewportDocumentExtent(
  root: WebTimelineViewportRoot,
  snapshot: TimelineViewportSnapshot,
  policy: TimelineViewportPolicy,
): void {
  const layout = projectTimelineViewportLayout(snapshot);
  const attributes = {
    timelineOverscroll: policy.threadOverscroll,
    timelineElasticEffect: String(policy.localElasticEffect),
    timelineTracksVisualViewport: String(policy.tracksVisualViewport),
    timelineKeyboardOpen: String(snapshot.keyboardInsetBottomPx > 0),
  };
  for (const [key, value] of Object.entries(attributes)) {
    if (root.dataset[key] !== value) root.dataset[key] = value;
  }
  setViewportProperty(root, "--timeline-layout-viewport-width", snapshot.layoutViewport.widthPx);
  setViewportProperty(root, "--timeline-layout-viewport-height", snapshot.layoutViewport.heightPx);
  setViewportProperty(root, "--timeline-available-viewport-width", layout.availableViewport.widthPx);
  setViewportProperty(root, "--timeline-available-viewport-height", layout.availableViewport.heightPx);
}

function applyTimelineViewportDocumentOrigin(
  root: WebTimelineViewportRoot,
  snapshot: TimelineViewportSnapshot,
  policy: TimelineViewportPolicy,
  fixedFrameOffset: TimelineViewportSnapshot["visualOffset"],
): void {
  // Capacity and the browser's fixed-position coordinate basis are independent.
  // The Web port measures that basis outside the positioned application tree.
  const followsVisualOrigin = policy.tracksVisualViewport && Math.abs(snapshot.scale - 1) <= 0.01;
  setViewportProperty(root, "--timeline-available-viewport-top", followsVisualOrigin ? fixedFrameOffset.topPx : 0);
  setViewportProperty(root, "--timeline-available-viewport-left", followsVisualOrigin ? fixedFrameOffset.leftPx : 0);
}

export function createWebTimelineViewportPort(
  windowObject: Window,
  documentObject: Document,
  options: WebTimelineViewportOptions,
): TimelineViewportPort {
  const listeners = new Set<() => void>();
  const root = documentObject.documentElement;
  const navigatorObject = windowObject.navigator;
  const resolvedPlatform = resolveWebTimelinePlatform({
    maxTouchPoints: navigatorObject.maxTouchPoints,
    navigatorPlatform: navigatorObject.platform,
    userAgent: navigatorObject.userAgent,
  });
  const policy = resolveTimelineViewportPolicy({
    kind: options.kind,
    platform: resolvedPlatform === "ios" || resolvedPlatform === "android"
      ? resolvedPlatform
      : options.platform,
  });
  // This zero-inset reference is never positioned by our viewport CSS. Reading
  // Shell's rectangle instead would feed our previous output back into input.
  // WKWebView may move the fixed plane independently of VisualViewport events.
  const fixedReference = policy.tracksVisualViewport ? documentObject.createElement("div") : null;
  if (fixedReference) {
    fixedReference.dataset.timelineFixedReference = "";
    fixedReference.setAttribute("aria-hidden", "true");
    fixedReference.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;margin:0;visibility:hidden;pointer-events:none;contain:strict;";
    documentObject.body.append(fixedReference);
  }
  let revision = 0;
  let frame: number | null = null;
  let disposed = false;
  // Native keyboard/browser chrome transitions can finish after their last
  // viewport event. Reconcile briefly, without a permanent polling owner.
  // A compatibility grace period, not a keyboard-open state or completion signal.
  // End only at the deadline: identical early frames do not prove native pan ended.
  const settleDurationMs = policy.tracksVisualViewport ? 1_000 : 0;
  let settleUntil = 0;
  let observationEvent: Event | undefined;

  const read = (): TimelineViewportSnapshot => {
    const visualViewport = windowObject.visualViewport;
    return createWebTimelineViewportSnapshot({
      editableFocused: isEditableElement(documentObject.activeElement),
      // innerHeight can already describe the keyboard-reduced visual viewport
      // in WKWebView while the CSS layout viewport remains at its old height.
      layoutHeightPx: root.clientHeight || windowObject.innerHeight,
      layoutWidthPx: root.clientWidth || windowObject.innerWidth,
      revision,
      scale: visualViewport?.scale ?? 1,
      visualHeightPx: visualViewport?.height,
      visualOffsetLeftPx: visualViewport?.offsetLeft,
      visualOffsetTopPx: visualViewport?.offsetTop,
      visualWidthPx: visualViewport?.width,
    });
  };
  const readFixedFrameOffset = () => {
    if (!fixedReference) return { topPx: 0, leftPx: 0 };
    const visual = windowObject.visualViewport;
    const reference = fixedReference?.getBoundingClientRect();
    // Convert the visible page origin into client coordinates before comparing
    // it with the independent fixed reference. WKWebView can report offsetTop,
    // pageTop and scrollY all as 294: adding offsetTop then compensates native
    // movement twice and puts the Shell 294px below the visible client origin.
    return {
      topPx: (visual?.pageTop ?? windowObject.scrollY + (visual?.offsetTop ?? 0))
        - windowObject.scrollY - (reference?.top ?? 0),
      leftPx: (visual?.pageLeft ?? windowObject.scrollX + (visual?.offsetLeft ?? 0))
        - windowObject.scrollX - (reference?.left ?? 0),
    };
  };
  const commitDocumentState = (next: TimelineViewportSnapshot) => {
    // Shrinking the focused editor's containing block can itself move the
    // browser's native fixed plane. Commit capacity before measuring that plane;
    // otherwise the origin describes the previous layout for a painted frame.
    applyTimelineViewportDocumentExtent(root, next, policy);
    const offset = readFixedFrameOffset(); // independent read also flushes layout
    applyTimelineViewportDocumentOrigin(root, next, policy, offset);
    return offset;
  };
  let snapshot = read();
  let fixedFrameOffset = commitDocumentState(snapshot);
  const observe = () => {
    if (!policy.tracksVisualViewport) return;
    const event = observationEvent;
    observationEvent = undefined;
    options.onGeometryObserved?.(event);
  };

  const scheduleFrame = () => {
    if (frame === null && !disposed) frame = windowObject.requestAnimationFrame(publish);
  };
  const reconcile = () => {
    if (disposed || documentObject.visibilityState === "hidden") return;
    const nextFixedFrameOffset = commitDocumentState(read());
    const next = read();
    if (
      next.editableFocused !== snapshot.editableFocused
      || next.scale !== snapshot.scale
      || next.layoutViewport.widthPx !== snapshot.layoutViewport.widthPx
      || next.layoutViewport.heightPx !== snapshot.layoutViewport.heightPx
      || next.visualViewport.widthPx !== snapshot.visualViewport.widthPx
      || next.visualViewport.heightPx !== snapshot.visualViewport.heightPx
      || next.visualOffset.leftPx !== snapshot.visualOffset.leftPx
      || next.visualOffset.topPx !== snapshot.visualOffset.topPx
      || nextFixedFrameOffset.topPx !== fixedFrameOffset.topPx
      || nextFixedFrameOffset.leftPx !== fixedFrameOffset.leftPx
    ) {
      revision += 1;
      snapshot = { ...next, revision };
      fixedFrameOffset = nextFixedFrameOffset;
      for (const listener of listeners) listener();
    }
    // Evidence follows the committed frame even if no raw snapshot changed.
    // Observers cannot extend the grace period or own another animation loop.
    observe();
  };
  const publish = (now: number) => {
    frame = null;
    reconcile();
    if (now < settleUntil) scheduleFrame();
  };
  const schedule = (event?: Event) => {
    if (disposed) return;
    if (documentObject.visibilityState === "hidden") {
      if (frame !== null) windowObject.cancelAnimationFrame(frame);
      frame = null;
      settleUntil = 0;
      observationEvent = undefined;
      return;
    }
    // Keep contact coordinates until the next committed observation. A later
    // resize in the same task must not replace the pending contact event.
    if (event?.type === "touchstart" || observationEvent?.type !== "touchstart") observationEvent = event;
    settleUntil = windowObject.performance.now() + settleDurationMs;
    scheduleFrame();
  };
  const onViewportChange = (event: Event) => {
    schedule(event);
    // Native viewport events may be delivered after this frame's rAF phase.
    // Finish their shared geometry commit before returning to browser painting.
    // Focus and touch only invalidate; they do not yet describe new geometry.
    if (policy.tracksVisualViewport) reconcile();
  };
  const visualViewport = windowObject.visualViewport;
  windowObject.addEventListener("resize", onViewportChange, { passive: true });
  windowObject.addEventListener("scroll", onViewportChange, { passive: true });
  visualViewport?.addEventListener("resize", onViewportChange, { passive: true });
  visualViewport?.addEventListener("scroll", onViewportChange, { passive: true });
  documentObject.addEventListener("focusin", schedule, { passive: true });
  documentObject.addEventListener("focusout", schedule, { passive: true });
  if (policy.tracksVisualViewport) {
    windowObject.addEventListener("pageshow", schedule, { passive: true });
    windowObject.addEventListener("focus", schedule, { passive: true });
    windowObject.addEventListener("orientationchange", schedule, { passive: true });
    documentObject.addEventListener("visibilitychange", schedule, { passive: true });
    // Observation only: a missed terminal event must not survive the next
    // interaction, including descendants that stop bubbling. Input stays native.
    documentObject.addEventListener("touchstart", schedule, { passive: true, capture: true });
    // Nested native focus-reveal scrolling is evidence from this same owner.
    documentObject.addEventListener("scroll", schedule, { passive: true, capture: true });
    schedule();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame !== null) windowObject.cancelAnimationFrame(frame);
      frame = null;
      windowObject.removeEventListener("resize", onViewportChange);
      windowObject.removeEventListener("scroll", onViewportChange);
      visualViewport?.removeEventListener("resize", onViewportChange);
      visualViewport?.removeEventListener("scroll", onViewportChange);
      documentObject.removeEventListener("focusin", schedule);
      documentObject.removeEventListener("focusout", schedule);
      if (policy.tracksVisualViewport) {
        windowObject.removeEventListener("pageshow", schedule);
        windowObject.removeEventListener("focus", schedule);
        windowObject.removeEventListener("orientationchange", schedule);
        documentObject.removeEventListener("visibilitychange", schedule);
        documentObject.removeEventListener("touchstart", schedule, true);
        documentObject.removeEventListener("scroll", schedule, true);
      }
      observationEvent = undefined;
      listeners.clear();
      fixedReference?.remove();
    },
  };
}
