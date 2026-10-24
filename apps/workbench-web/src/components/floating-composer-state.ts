
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
  },
) {
  const handles = input.floating && input.readiness === "ready";
  const collapsed = handles && input.tabId !== null && state.collapsedTabs.has(input.tabId);
  const peeked = collapsed && state.enabled;
  const wantsHidden = handles && (!state.enabled || collapsed);
  const phase: OverlayPhase = wantsHidden
    ? state.phase === "exiting" ? "exiting" : "hidden"
    : state.phase === "entering" ? "entering" : "visible";
  const expanded = input.forceExpanded || (input.tabId !== null && input.tabId === state.focusedTab);
  return {
    phase,
    peeked,
    mounted: peeked || phase !== "hidden",
    interactive: phase === "visible",
    density: input.floating ? expanded ? "expanded" : "compact" : "default",
    handles,
  } as const;
}

export class FloatingComposerState {
  private value: FloatingComposerSnapshot = {
    enabled: true,
    collapsedTabs: new Map(),
    focusedTab: null,
    phase: "visible",
  };
  private readonly observers = new Set<() => void>();
  private pending: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;

  get hasSubscribers(): boolean { return this.observers.size > 0; }
  getSnapshot = (): FloatingComposerSnapshot => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.observers.add(listener);
    return () => { this.observers.delete(listener); };
  };

  private update(patch: Partial<FloatingComposerSnapshot>): void {
    this.value = { ...this.value, ...patch };
    for (const observer of this.observers) observer();
  }

  focus(tabId: string | null): void {
    if (tabId !== this.value.focusedTab) this.update({ focusedTab: tabId });
  }

  private animate(visible: boolean, reducedMotion: boolean): void {
    const ticket = ++this.revision;
    if (this.pending !== undefined) clearTimeout(this.pending);
    this.pending = undefined;
    const destination = visible ? "visible" : "hidden";
    this.update({ phase: reducedMotion ? destination : visible ? "entering" : "exiting" });
    if (!reducedMotion) {
      this.pending = setTimeout(() => {
        if (ticket !== this.revision) return;
        this.pending = undefined;
        this.update({ phase: destination });
      }, 120);
    }
  }

  settle(): void {
    ++this.revision;
    if (this.pending !== undefined) clearTimeout(this.pending);
    this.pending = undefined;
    if (this.value.phase === "entering") this.update({ phase: "visible" });
    else if (this.value.phase === "exiting") this.update({ phase: "hidden" });
  }

  private collapse(tabId: string, reason: CollapseReason, reducedMotion: boolean): void {
    const collapsedTabs = new Map(this.value.collapsedTabs);
    collapsedTabs.set(tabId, reason);
    this.update({ collapsedTabs, ...(reason === "manual" ? { focusedTab: null } : {}) });
    this.animate(false, reducedMotion);
  }

  hide(tabId: string | null, reducedMotion = false): void {
    if (!tabId || !this.value.enabled || this.value.collapsedTabs.has(tabId)) return;
    this.collapse(tabId, "manual", reducedMotion);
  }

  show(tabId: string | null, reducedMotion = false): void {
    if (!tabId || !this.value.enabled || !this.value.collapsedTabs.has(tabId)) return;
    this.reveal(tabId, reducedMotion);
  }

  private reveal(tabId: string, reducedMotion: boolean): void {
    const collapsedTabs = new Map(this.value.collapsedTabs);
    collapsedTabs.delete(tabId);
    this.update({ collapsedTabs });
    this.animate(true, reducedMotion);
  }

  toggle(tabId: string | null, reducedMotion = false): void {
    const collapsedTabs = new Map(this.value.collapsedTabs);
    const revealing = tabId !== null && collapsedTabs.has(tabId);
    const enabled = revealing || !this.value.enabled;
    if (enabled && tabId !== null) collapsedTabs.delete(tabId);
    this.update({ enabled, collapsedTabs });
    this.animate(enabled, reducedMotion);
  }

  autoCollapse(tabId: string, collapse: boolean, editorOrMenuActive: boolean, reducedMotion = false): void {
    const reason = this.value.collapsedTabs.get(tabId);
    if (collapse) {
      if (editorOrMenuActive || reason !== undefined) return;
      this.collapse(tabId, "auto-collapse", reducedMotion);
    } else if (reason === "auto-collapse") {
      this.reveal(tabId, reducedMotion);
    }
  }
}

/** Shell-owned recent route intent. Subscribers pin their entries during use. */
export class FloatingComposerRegistry {
  private readonly recent = new Map<string, FloatingComposerState>();

  get(scopeId: string): FloatingComposerState {
    const state = this.recent.get(scopeId) ?? new FloatingComposerState();
    this.recent.delete(scopeId);
    this.recent.set(scopeId, state);
    return state;
  }

  release(scopeId: string): void {
    this.recent.get(scopeId)?.settle();
    for (const [key, state] of this.recent) {
      if (this.recent.size <= 20) break;
      if (!state.hasSubscribers) {
        state.settle();
        this.recent.delete(key);
      }
    }
  }
}

/** Keep an initiating wheel action from consuming its own trailing momentum. */
export class ComposerWheelSwipeController {
  private gesture: {
    start: number;
    lastTime: number;
    lastMagnitude: number;
    peakMagnitude: number;
    decayed: boolean;
    idle: number;
  } | undefined;

  beginSwipe(event: Pick<WheelEvent, "deltaY" | "timeStamp">, origin: "peek" | "composer"): void {
    const magnitude = Math.abs(event.deltaY);
    this.gesture = {
      start: event.timeStamp,
      lastTime: event.timeStamp,
      lastMagnitude: magnitude,
      peakMagnitude: magnitude,
      decayed: false,
      idle: origin === "peek" ? 400 : 150,
    };
  }

  isContinuation(event: Pick<WheelEvent, "deltaY" | "timeStamp">): boolean {
    const gesture = this.gesture;
    if (!gesture) return false;
    const magnitude = Math.abs(event.deltaY);
    const expired = event.timeStamp - gesture.lastTime >= gesture.idle;
    const restarted = event.timeStamp - gesture.start >= 200
      && gesture.decayed && magnitude > gesture.lastMagnitude + 8;
    if (expired || restarted) {
      this.gesture = undefined;
      return false;
    }
    gesture.peakMagnitude = Math.max(gesture.peakMagnitude, magnitude);
    gesture.decayed ||= magnitude <= gesture.peakMagnitude / 2;
    gesture.lastMagnitude = magnitude;
    gesture.lastTime = event.timeStamp;
    return true;
  }
}
