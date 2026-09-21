import {
  calculateSoftwareKeyboardInset,
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
): void {
  root.dataset.timelineOverscroll = policy.threadOverscroll;
  root.dataset.timelineElasticEffect = String(policy.localElasticEffect);
  root.dataset.timelineTracksVisualViewport = String(policy.tracksVisualViewport);
  root.dataset.timelineKeyboardOpen = String(snapshot.keyboardInsetBottomPx > 0);
  root.style.setProperty("--timeline-layout-viewport-width", `${snapshot.layoutViewport.widthPx}px`);
  root.style.setProperty("--timeline-layout-viewport-height", `${snapshot.layoutViewport.heightPx}px`);
  root.style.setProperty("--timeline-visual-viewport-width", `${snapshot.visualViewport.widthPx}px`);
  root.style.setProperty("--timeline-visual-viewport-height", `${snapshot.visualViewport.heightPx}px`);
  root.style.setProperty("--timeline-visual-viewport-offset-left", `${snapshot.visualOffset.leftPx}px`);
  root.style.setProperty("--timeline-visual-viewport-offset-top", `${snapshot.visualOffset.topPx}px`);
  root.style.setProperty("--timeline-keyboard-inset-bottom", `${snapshot.keyboardInsetBottomPx}px`);
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
  let revision = 0;
  let frame: number | null = null;
  let disposed = false;

  const read = (): TimelineViewportSnapshot => {
    const visualViewport = windowObject.visualViewport;
    return createWebTimelineViewportSnapshot({
      editableFocused: isEditableElement(documentObject.activeElement),
      layoutHeightPx: windowObject.innerHeight,
      layoutWidthPx: windowObject.innerWidth,
      revision,
      scale: visualViewport?.scale ?? 1,
      visualHeightPx: visualViewport?.height,
      visualOffsetLeftPx: visualViewport?.offsetLeft,
      visualOffsetTopPx: visualViewport?.offsetTop,
      visualWidthPx: visualViewport?.width,
    });
  };
  let snapshot = read();
  applyTimelineViewportDocumentState(root, snapshot, policy);

  const publish = () => {
    frame = null;
    if (disposed) return;
    revision += 1;
    snapshot = read();
    applyTimelineViewportDocumentState(root, snapshot, policy);
    for (const listener of listeners) listener();
  };
  const schedule = () => {
    if (frame === null && !disposed) frame = windowObject.requestAnimationFrame(publish);
  };
  const visualViewport = windowObject.visualViewport;
  windowObject.addEventListener("resize", schedule, { passive: true });
  visualViewport?.addEventListener("resize", schedule, { passive: true });
  visualViewport?.addEventListener("scroll", schedule, { passive: true });
  documentObject.addEventListener("focusin", schedule, { passive: true });
  documentObject.addEventListener("focusout", schedule, { passive: true });

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
      windowObject.removeEventListener("resize", schedule);
      visualViewport?.removeEventListener("resize", schedule);
      visualViewport?.removeEventListener("scroll", schedule);
      documentObject.removeEventListener("focusin", schedule);
      documentObject.removeEventListener("focusout", schedule);
      listeners.clear();
    },
  };
}
