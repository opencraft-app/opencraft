/** Page selection belongs to the panel, never to its current geometry. */
export interface AdaptivePanelState {
  readonly secondaryId: string | null;
  readonly active: "primary" | "secondary";
}
export interface PanelPage {
  readonly id: string;
  readonly minWidth: number;
}
export class AdaptivePanel {
  private state: AdaptivePanelState = Object.freeze({ secondaryId: null, active: "primary" });
  private listeners = new Set<() => void>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(secondaryId: string | null, active: AdaptivePanelState["active"]) {
    if (secondaryId === this.state.secondaryId && active === this.state.active) return;
    this.state = Object.freeze({ secondaryId, active });
    this.listeners.forEach(listener => listener());
  }
  select(id: string) {
    if (!id) throw new Error("Panel page identity must not be empty");
    this.update(id, "secondary");
  }
  /** Initial selection does not push the compact panel forward. */
  seed(id: string) {
    if (!id) throw new Error("Panel page identity must not be empty");
    if (this.state.secondaryId === null) this.update(id, "primary");
  }
  back = () => { this.update(this.state.secondaryId, "primary"); };
  /** Explicitly close a deleted/cancelled page, unlike Back. */
  clear = () => { this.update(null, "primary"); };
}

/** Shared by DOM and native adapters; measuring the container is platform-owned. */
export function projectPanel(state: AdaptivePanelState, primary: PanelPage, secondary: PanelPage | undefined, width: number) {
  for (const page of [primary, secondary]) {
    if (page && (!page.id || !Number.isFinite(page.minWidth) || page.minWidth <= 0)) throw new Error("Invalid panel page");
  }
  if (secondary && (secondary.id !== state.secondaryId || secondary.id === primary.id)) throw new Error("Panel selection has no matching page");
  if (state.secondaryId !== null && !secondary) throw new Error("Selected panel page is missing");
  const split = !!secondary && width >= primary.minWidth + secondary.minWidth;
  const visible = split ? [primary.id, secondary!.id] : [secondary && state.active === "secondary" ? secondary.id : primary.id];
  return { visible, split, canGoBack: !split && !!secondary && state.active === "secondary" };
}
