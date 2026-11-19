import { motionReductionQuery } from "./use-motion-reduction";
import { FrameBudget, type FrameClient } from "@opencraft/design-system/frame-budget";
import { companionMotionPolicy } from "@opencraft/design-system/companion-motion";

interface Registration {
  client: FrameClient;
  release?: () => void;
}
const owners = new WeakMap<Document, VisualFrameBudget>();
/** One RAF, observer and preference listener per Document, released with its last consumer. */
class VisualFrameBudget {
  private budget: FrameBudget;
  private registrations = new Map<Element, Registration>();
  private observer: IntersectionObserver;
  private preference: MediaQueryList;
  private raf: number | null = null;
  constructor(
    private document: Document,
    private window: Window & typeof globalThis,
  ) {
    this.budget = new FrameBudget(companionMotionPolicy, () => window.performance.now());
    this.preference = window.matchMedia(motionReductionQuery);
    this.observer = new window.IntersectionObserver((entries) => {
      for (const entry of entries) {
        const r = this.registrations.get(entry.target);
        if (!r) continue;
        if (entry.isIntersecting && entry.intersectionRatio > 0) r.release ??= this.budget.add(r.client);
        else {
          r.release?.();
          r.release = undefined;
        }
      }
      this.reconcile();
    });
    document.addEventListener("visibilitychange", this.reconcile);
    this.preference.addEventListener("change", this.reconcile);
    window.addEventListener("pagehide", this.hide);
    window.addEventListener("pageshow", this.reconcile);
    this.reconcile();
  }
  private hide = () => {
    this.budget.setEnabled(false);
    this.cancel();
  };
  private reconcile = () => {
    this.budget.setEnabled(this.document.visibilityState === "visible" && !this.preference.matches);
    if (this.budget.active) this.schedule();
    else this.cancel();
  };
  private cancel() {
    if (this.raf !== null) this.window.cancelAnimationFrame(this.raf);
    this.raf = null;
  }
  private schedule() {
    if (this.raf === null) this.raf = this.window.requestAnimationFrame(this.tick);
  }
  private tick = (time: number) => {
    this.raf = null;
    this.budget.frame(time);
    if (this.budget.active) this.schedule();
  };
  observe(element: Element, client: FrameClient) {
    if (this.registrations.has(element)) throw Error("Visual already has a frame owner");
    const record: Registration = { client };
    this.registrations.set(element, record);
    this.observer.observe(element);
    return () => {
      if (!this.registrations.delete(element)) return;
      this.observer.unobserve(element);
      record.release?.();
      client.pause();
      this.reconcile();
      if (this.registrations.size) return;
      this.cancel();
      this.observer.disconnect();
      this.document.removeEventListener("visibilitychange", this.reconcile);
      this.preference.removeEventListener("change", this.reconcile);
      this.window.removeEventListener("pagehide", this.hide);
      this.window.removeEventListener("pageshow", this.reconcile);
      owners.delete(this.document);
    };
  }
}
export function observeBudgetedVisual(element: Element, client: FrameClient): () => void {
  const document = element.ownerDocument,
    window = document.defaultView;
  // Server rendering and older embedding hosts get the complete static artwork.
  if (!window || !("IntersectionObserver" in window) || !window.requestAnimationFrame) {
    client.pause();
    return () => {};
  }
  let owner = owners.get(document);
  if (!owner) {
    owner = new VisualFrameBudget(document, window);
    owners.set(document, owner);
  }
  return owner.observe(element, client);
}
