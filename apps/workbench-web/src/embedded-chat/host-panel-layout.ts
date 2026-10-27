import { animate, motionValue } from "motion";
import { hostPanelDragProgress, hostPanelReleaseOpen, resolveHostPanelGeometry,
  type HostPanelCommand, type HostPanelGeometry, type HostPanelGesture, type HostPanelState } from "@opencraft/workbench-panels/host-presentation";

/** One parent allocates two sibling viewports. The panel service owns intent;
 * this adapter owns only interruptible presentation and contact lifetime. */
export class EmbeddedHostPanelLayout {
  readonly plane = document.createElement("div");
  readonly frame = document.createElement("div");
  private state: HostPanelState | null = null;
  private geometry: HostPanelGeometry | null = null;
  private readonly progress = motionValue(0);
  private animation: ReturnType<typeof animate> | null = null;
  private animationTarget = 0;
  private gesture: { id: number; origin: number; translation: number; width: number } | null = null;
  private lastGestureId = 0;
  private readonly listeners = new Set<() => void>();
  private active = false;
  private readonly stopProgress: () => void;
  private disposed = false;

  constructor(private readonly chat: HTMLElement, private readonly panel: HTMLElement,
    private readonly commit: (command: HostPanelCommand) => boolean) {
    this.plane.className = "opencraft-host-pane-layout";
    this.frame.className = "opencraft-host-panel-frame";
    this.frame.append(panel);
    this.plane.append(chat, this.frame);
    this.stopProgress = this.progress.on("change", () => this.render());
    this.render();
  }
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getSnapshot = () => this.active;

  setState(state: HostPanelState): void {
    if (this.disposed) return;
    const previous = this.state;
    this.state = state;
    if (previous?.ownerId !== state.ownerId) {
      this.stopAnimation(); this.gesture = null; this.geometry = null; this.lastGestureId = 0;
      this.animationTarget = state.available && state.open ? 1 : 0;
      this.progress.set(this.animationTarget);
    } else if (!state.available || state.open !== previous.open) {
      // An external owner intent cancels a held contact. Its late end is inert.
      this.gesture = null;
      this.settle(state.available && state.open ? 1 : 0);
    }
    this.render();
  }
  setGeometry(geometry: HostPanelGeometry): void {
    if (this.disposed) return;
    const changed = this.geometry && (this.geometry.containerWidth !== geometry.containerWidth || this.geometry.overlay !== geometry.overlay);
    this.geometry = geometry;
    if (changed && this.gesture) {
      this.gesture = null;
      this.settle(this.state?.open ? 1 : 0);
    }
    this.render();
  }
  dispatchGesture(input: HostPanelGesture): boolean {
    if (this.disposed || !this.state?.available || !this.geometry) return false;
    if (input.phase === "start") {
      if (input.id <= this.lastGestureId) return false;
      this.lastGestureId = input.id;
      this.stopAnimation();
      this.gesture = { id: input.id, origin: Math.max(0, Math.min(1, this.progress.get())), translation: input.translationX, width: this.capacity().panelWidth };
      this.render();
      return true;
    }
    const gesture = this.gesture;
    if (!gesture || gesture.id !== input.id) return false;
    if (input.phase !== "cancel") this.progress.set(hostPanelDragProgress(gesture.origin, input.translationX - gesture.translation, gesture.width));
    if (input.phase === "move") return true;
    this.gesture = null;
    const requested = input.phase === "cancel" ? this.state.open : hostPanelReleaseOpen(this.progress.get(), input.velocityX, gesture.width);
    const accepted = requested === this.state.open || this.commit({ ownerId: this.state.ownerId, action: "open", open: requested });
    this.settle((accepted ? requested : this.state.open) ? 1 : 0);
    return true;
  }
  dispose(): void {
    this.disposed = true; this.gesture = null; this.stopAnimation(); this.stopProgress(); this.listeners.clear();
  }
  private capacity(): HostPanelGeometry {
    return resolveHostPanelGeometry(this.geometry?.containerWidth ?? 0, this.state ? { ...this.state, open: true } : null,
      this.geometry?.chromeHeight ?? 0, this.geometry?.panelWidth || undefined);
  }
  private stopAnimation(): void { this.animation?.stop(); this.animation = null; }
  private settle(target: number): void {
    if (this.animation && target === this.animationTarget) return;
    this.stopAnimation(); this.animationTarget = target;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { this.progress.set(target); this.render(); return; }
    this.animation = animate(this.progress, target, { type: "spring", stiffness: 430, damping: 36, restDelta: 0.001, restSpeed: 0.001,
      onComplete: () => { this.animation = null; this.render(); } });
    this.render();
  }
  private render(): void {
    const capacity = this.capacity();
    const progress = this.state?.available ? Math.max(0, Math.min(1, this.progress.get())) : 0;
    const active = this.state?.available === true && (this.state.open || progress > 0 || this.gesture !== null || this.animation !== null);
    const interactive = active && this.gesture === null && progress >= 0.999 && this.state?.open === true;
    this.plane.dataset.panelLayout = capacity.overlay ? "overlay" : "split";
    this.plane.dataset.panelProgress = String(progress);
    this.plane.style.gridTemplateColumns = capacity.overlay ? "minmax(0, 1fr)" : `minmax(0, 1fr) ${capacity.panelWidth * progress}px`;
    this.frame.style.gridColumn = capacity.overlay ? "1" : "2";
    this.frame.style.width = capacity.overlay ? "100%" : "auto";
    this.frame.style.transform = capacity.overlay ? `translateX(${capacity.panelWidth * (1 - progress)}px)` : "";
    this.frame.style.visibility = active ? "visible" : "hidden";
    this.frame.inert = !interactive;
    this.panel.style.width = `${capacity.panelWidth}px`;
    this.panel.style.paddingTop = `${capacity.chromeHeight}px`;
    this.chat.inert = active && capacity.overlay;
    if (active !== this.active) { this.active = active; this.listeners.forEach(listener => listener()); }
  }
}
