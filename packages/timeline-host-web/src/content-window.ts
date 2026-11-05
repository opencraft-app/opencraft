import { resizeObserverBlockSize } from "./measurement";

interface ContentRegistration {
  readonly key: string;
  readonly update: (visible: boolean) => void;
  visible: boolean;
  rendered: boolean;
}

/** Mount demand only. The conversation viewport remains the sole scroll and
 * compensation owner; these elements stay in its normal document flow. */
export class WebConversationContentWindow {
  private root: HTMLElement | null = null;
  private intersection: IntersectionObserver | null = null;
  private resize: ResizeObserver | null = null;
  private readonly registrations = new Map<HTMLElement, ContentRegistration>();
  private readonly heights = new Map<string, number>();
  private disposed = false;

  restore(heights: Readonly<Record<string, number>>): void {
    for (const [key, height] of Object.entries(heights)) {
      if (Number.isFinite(height) && height >= 0) this.heights.set(key, height);
    }
  }

  capture(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.heights);
  }

  attach(root: HTMLElement | null): void {
    if (this.disposed || this.root === root) return;
    this.intersection?.disconnect();
    this.intersection = null;
    this.root = root;
    if (root === null) return;
    if (typeof IntersectionObserver === "undefined") {
      for (const entry of this.registrations.values()) entry.update(true);
      return;
    }
    const observer = new IntersectionObserver(records => {
      if (this.disposed || this.intersection !== observer || root.clientHeight === 0) return;
      for (const record of records) {
        const element = record.target as HTMLElement;
        const entry = this.registrations.get(element);
        if (!entry) continue;
        entry.visible = record.isIntersecting;
        entry.update(entry.visible || this.protected(element));
      }
    }, { root, rootMargin: "1000px 0px", threshold: 0 });
    this.intersection = observer;
    for (const element of this.registrations.keys()) observer.observe(element);
  }

  height(key: string, estimate: number): number {
    return this.heights.get(key) ?? estimate;
  }

  observe(element: HTMLElement, key: string, update: (visible: boolean) => void): () => void {
    if (this.disposed) return () => undefined;
    const entry: ContentRegistration = { key, update, visible: false, rendered: false };
    this.registrations.set(element, entry);
    this.intersection?.observe(element);
    if (this.root && typeof IntersectionObserver === "undefined") update(true);
    return () => {
      if (this.registrations.get(element) !== entry) return;
      this.intersection?.unobserve(element);
      this.resize?.unobserve(element);
      this.registrations.delete(element);
    };
  }

  rendered(element: HTMLElement, rendered: boolean): void {
    const entry = this.registrations.get(element);
    if (!entry || entry.rendered === rendered) return;
    entry.rendered = rendered;
    if (!rendered) { this.resize?.unobserve(element); return; }
    this.resize ??= new ResizeObserver(records => {
      if (this.disposed || this.root?.clientHeight === 0) return;
      for (const record of records) {
        const entry = this.registrations.get(record.target as HTMLElement);
        // Placeholder sizes must never overwrite measured content heights.
        if (entry?.rendered) this.heights.set(entry.key, resizeObserverBlockSize(record));
      }
    });
    this.resize.observe(element, { box: "border-box" });
  }

  /** User work outlives visibility. A later visibility observation may retire
   * the row after the selection/disclosure/focus has been released. */
  private protected(element: HTMLElement): boolean {
    const document = element.ownerDocument;
    const selection = document.getSelection();
    return element.contains(document.activeElement)
      || Boolean(selection && !selection.isCollapsed && selection.rangeCount > 0
        && selection.getRangeAt(0).intersectsNode(element))
      || element.querySelector('[aria-expanded="true"], [data-open="true"], [data-mcp-app-expanded="true"]') !== null;
  }

  dispose(): void {
    this.disposed = true;
    this.intersection?.disconnect();
    this.resize?.disconnect();
    this.intersection = null;
    this.resize = null;
    this.registrations.clear();
    this.heights.clear();
    this.root = null;
  }
}
