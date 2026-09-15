/** Codex overlay state ports: RouteScope intent + tab collapse reason, not draft state.
 * Source: create-composer-overlay-reactive-state / compute-contain-scale-factor.
 * Names express behavior (some recovered upstream symbol names are inverted).
 */
export type OverlayPhase = "entering" | "visible" | "exiting" | "hidden";
export type CollapseReason = "manual" | "auto-collapse";
export type BrowserReadiness = "ready" | "loading" | "unavailable";
export interface FloatingComposerSnapshot {
  readonly enabled: boolean;
  readonly collapsedTabs: ReadonlyMap<string, CollapseReason>;
  readonly focusedTab: string | null;
  readonly phase: OverlayPhase;
}

export function projectFloatingComposer(
  state: FloatingComposerSnapshot,
  input: {
    floating: boolean;
    tabId: string | null;
    readiness: BrowserReadiness;
    forceExpanded?: boolean;
  }
) {
  const shown =
    state.enabled &&
    (input.tabId === null || !state.collapsedTabs.has(input.tabId));
  const ready = input.readiness === "ready";
  const visible = !input.floating || !ready || shown;
  const peeked = input.floating && ready && state.enabled && !shown;
  const phase = visible
    ? state.phase === "entering"
      ? "entering"
      : "visible"
    : state.phase === "exiting"
    ? "exiting"
    : "hidden";
  return {
    phase,
    peeked,
    mounted: phase !== "hidden" || peeked,
    interactive: phase === "visible" && !peeked,
    density: !input.floating
      ? "default"
      : input.forceExpanded ||
        (input.tabId !== null && state.focusedTab === input.tabId)
      ? "expanded"
      : "compact",
    handles: input.floating && ready,
  } as const;
}

export class FloatingComposerState {
  private snapshot: FloatingComposerSnapshot = {
    enabled: true,
    collapsedTabs: new Map(),
    focusedTab: null,
    phase: "visible",
  };
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  get hasSubscribers() { return this.listeners.size > 0; }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.settle();
    };
  };
  private publish(patch: Partial<FloatingComposerSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  focus(tabId: string | null) {
    if (this.snapshot.focusedTab !== tabId) this.publish({ focusedTab: tabId });
  }
  private transition(visible: boolean, reducedMotion: boolean) {
    clearTimeout(this.timer);
    const generation = ++this.generation;
    this.publish({
      phase: reducedMotion
        ? visible
          ? "visible"
          : "hidden"
        : visible
        ? "entering"
        : "exiting",
    });
    if (!reducedMotion)
      this.timer = setTimeout(() => {
        if (generation === this.generation)
          this.publish({ phase: visible ? "visible" : "hidden" });
      }, 120);
  }
  settle() {
    clearTimeout(this.timer);
    this.generation++;
    if (this.snapshot.phase === "entering" || this.snapshot.phase === "exiting")
      this.publish({
        phase: this.snapshot.phase === "entering" ? "visible" : "hidden",
      });
  }
  hide(tabId: string | null, reducedMotion = false) {
    if (
      !tabId ||
      !this.snapshot.enabled ||
      this.snapshot.collapsedTabs.has(tabId)
    )
      return;
    this.publish({
      collapsedTabs: new Map(this.snapshot.collapsedTabs).set(tabId, "manual"),
      focusedTab: null,
    });
    this.transition(false, reducedMotion);
  }
  show(tabId: string | null, reducedMotion = false) {
    if (
      !tabId ||
      !this.snapshot.enabled ||
      !this.snapshot.collapsedTabs.has(tabId)
    )
      return;
    const tabs = new Map(this.snapshot.collapsedTabs);
    tabs.delete(tabId);
    this.publish({ collapsedTabs: tabs });
    this.transition(true, reducedMotion);
  }
  toggle(tabId: string | null, reducedMotion = false) {
    const shown =
      this.snapshot.enabled &&
      (tabId === null || !this.snapshot.collapsedTabs.has(tabId));
    const tabs = new Map(this.snapshot.collapsedTabs);
    if (!shown && tabId !== null) tabs.delete(tabId);
    this.publish({ enabled: !shown, collapsedTabs: tabs });
    this.transition(!shown, reducedMotion);
  }
  autoCollapse(
    tabId: string,
    collapse: boolean,
    editorOrMenuActive: boolean,
    reducedMotion = false
  ) {
    const reason = this.snapshot.collapsedTabs.get(tabId);
    if (
      collapse
        ? reason != null || editorOrMenuActive
        : reason !== "auto-collapse"
    )
      return;
    const tabs = new Map(this.snapshot.collapsedTabs);
    if (collapse) tabs.set(tabId, "auto-collapse");
    else tabs.delete(tabId);
    this.publish({ collapsedTabs: tabs });
    this.transition(!collapse, reducedMotion);
  }
}

/** A bounded RouteScope analogue owned by the shell, never module-global. */
export class FloatingComposerRegistry {
  private readonly routes = new Map<string, FloatingComposerState>();
  get(scopeId: string) {
    let state = this.routes.get(scopeId);
    if (!state) {
      state = new FloatingComposerState();
    }
    this.routes.delete(scopeId);
    this.routes.set(scopeId, state);
    return state;
  }
  release(scopeId: string) {
    this.routes.get(scopeId)?.settle();
    if (this.routes.size > 20)
      for (const [key, state] of this.routes) {
        if (!state.hasSubscribers) {
          state.settle();
          this.routes.delete(key);
          if (this.routes.size <= 20) break;
        }
      }
  }
}

/** Source wheel-controller policy: momentum cannot trigger the next action.
 * ref/codex/modules/ui-islands-v8/use-toggle-diff-panel-subscription.js mDc.
 */
export class ComposerWheelSwipeController {
  private activeSwipe: {
    firstEventTimestamp: number;
    hasDecelerated: boolean;
    lastDeltaY: number;
    lastEventTimestamp: number;
    origin: "peek" | "composer";
    peakDeltaY: number;
  } | null = null;
  beginSwipe(
    event: Pick<WheelEvent, "deltaY" | "timeStamp">,
    origin: "peek" | "composer"
  ) {
    const delta = Math.abs(event.deltaY);
    this.activeSwipe = {
      firstEventTimestamp: event.timeStamp,
      hasDecelerated: false,
      lastDeltaY: delta,
      lastEventTimestamp: event.timeStamp,
      origin,
      peakDeltaY: delta,
    };
  }
  isContinuation(event: Pick<WheelEvent, "deltaY" | "timeStamp">) {
    const swipe = this.activeSwipe;
    if (!swipe) return false;
    const delta = Math.abs(event.deltaY);
    const newGesture =
      event.timeStamp - swipe.firstEventTimestamp >= 200 &&
      swipe.hasDecelerated &&
      delta > swipe.lastDeltaY + 8;
    if (
      event.timeStamp - swipe.lastEventTimestamp <
        (swipe.origin === "peek" ? 400 : 150) &&
      !newGesture
    ) {
      swipe.peakDeltaY = Math.max(swipe.peakDeltaY, delta);
      swipe.hasDecelerated ||= delta * 2 <= swipe.peakDeltaY;
      swipe.lastDeltaY = delta;
      swipe.lastEventTimestamp = event.timeStamp;
      return true;
    }
    this.activeSwipe = null;
    return false;
  }
}
