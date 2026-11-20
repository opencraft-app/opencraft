import { recordTimelineDiagnostic, timelineDiagnosticsEnabled, timelineDiagnosticId } from "./diagnostics";
import { resizeObserverBlockSize } from "./measurement";

export interface ConversationContentMeasurement {
  readonly heightPx: number;
  readonly widthPx: number;
  readonly typography: string;
}
const fontRevisions = new WeakMap<Document, number>();
type LayoutContext = Omit<ConversationContentMeasurement, "heightPx">;

interface ContentRegistration {
  readonly refresh: () => void;
  context: LayoutContext;
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
  private readonly measurements = new Map<string, ConversationContentMeasurement>();
  private mutations: MutationObserver | null = null;
  private releaseFonts: (() => void) | null = null;

  restore(heights: Readonly<Record<string, number>>, measurements: Readonly<Record<string, ConversationContentMeasurement>> = {}): void {
    for (const [key, value] of Object.entries(measurements)) {
      if (value && Number.isFinite(value.heightPx) && value.heightPx >= 0
        && Number.isFinite(value.widthPx) && value.widthPx >= 0 && typeof value.typography === "string")
        this.measurements.set(key, { ...value });
    }
    for (const [key, height] of Object.entries(heights)) {
      if (Number.isFinite(height) && height >= 0) this.heights.set(key, height);
    }
  }

  capture(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.heights);
  }

  captureMeasurements(): Readonly<Record<string, ConversationContentMeasurement>> {
    return Object.fromEntries(this.measurements);
  }

  private context(element: HTMLElement): LayoutContext {
    const document = element.ownerDocument;
    const style = document?.defaultView?.getComputedStyle(element);
    const typography = ["font-family", "font-size", "font-weight", "font-style", "font-stretch",
      "line-height", "letter-spacing", "word-spacing", "white-space", "text-transform",
      "font-feature-settings", "font-variation-settings", "font-kerning", "font-optical-sizing",
      "font-size-adjust", "font-variant", "font-synthesis", "tab-size", "word-break", "overflow-wrap",
      "direction", "writing-mode",
      // Shared typography tokens also govern descendants whose code/prose font
      // differs from the boundary's inherited font. They are geometry inputs.
      "--font-family-mono", "--typography-code-font", "--typography-chat-font",
      "--opencraft-chat-font-size", "--opencraft-chat-code-font-size", "--opencraft-chat-line-height"]
      .map(property => style?.getPropertyValue(property) ?? "").join("|");
    return { widthPx: Math.round((element.getBoundingClientRect?.().width ?? 0) * 100) / 100,
      typography: [typography, document?.fonts?.status ?? "", document?.fonts?.size ?? 0,
        document ? fontRevisions.get(document) ?? 0 : 0].join("|") };
  }

  private same(a: LayoutContext, b: LayoutContext): boolean {
    return a.widthPx === b.widthPx && a.typography === b.typography;
  }

  private invalidateLayouts(elements?: ReadonlySet<HTMLElement>, reason = "context"): void {
    if (this.disposed || this.root?.clientHeight === 0) return;
    let changed = false;
    let invalidated = 0;
    for (const [element, entry] of this.registrations) {
      if (elements && !elements.has(element)) continue;
      const context = this.context(element);
      if (this.same(context, entry.context)) continue;
      if (timelineDiagnosticsEnabled()) recordTimelineDiagnostic("content-invalidate", {
        viewport: timelineDiagnosticId(this), row: timelineDiagnosticId(element), reason,
        previousHeight: this.heights.get(entry.key) ?? null, rendered: entry.rendered,
        previousWidth: entry.context.widthPx, width: context.widthPx,
        typographyChanged: entry.context.typography !== context.typography,
      });
      invalidated++;
      entry.context = context;
      this.measurements.delete(entry.key);
      this.heights.delete(entry.key);
      entry.refresh();
      changed = true;
    }
    // Retire queued measurements from the old layout/font generation.
    if (changed) {
      if (timelineDiagnosticsEnabled()) recordTimelineDiagnostic("content-invalidation-batch", {
        viewport: timelineDiagnosticId(this), reason, count: invalidated, registrations: this.registrations.size,
      });
      this.resetResize();
    }
  }

  private resetResize(): void {
    this.resize?.disconnect();
    const observer = new ResizeObserver(records => {
      if (this.disposed || this.resize !== observer || this.root?.clientHeight === 0) return;
      this.invalidateLayouts(new Set(records.map(record => record.target as HTMLElement)), "resize-observer");
      if (this.resize !== observer) return;
      for (const record of records) {
        const element = record.target as HTMLElement, entry = this.registrations.get(element);
        if (!entry?.rendered) continue;
        const heightPx = resizeObserverBlockSize(record);
        if (timelineDiagnosticsEnabled()) recordTimelineDiagnostic("content-measured", {
          viewport: timelineDiagnosticId(this), row: timelineDiagnosticId(element),
          previousHeight: this.heights.get(entry.key) ?? null, height: heightPx,
        });
        this.heights.set(entry.key, heightPx);
        this.measurements.set(entry.key, { ...entry.context, heightPx });
      }
    });
    this.resize = observer;
    for (const element of this.registrations.keys()) observer.observe(element, { box: "border-box" });
  }

  attach(root: HTMLElement | null): void {
    if (this.disposed || this.root === root) return;
    this.intersection?.disconnect();
    this.intersection = null;
    this.resize?.disconnect();
    this.resize = null;
    this.mutations?.disconnect();
    this.releaseFonts?.();
    this.mutations = null;
    this.releaseFonts = null;
    this.root = root;
    if (root === null) return;
    const document = root.ownerDocument;
    if (document?.fonts) {
      const changed = (event?: Event) => {
        fontRevisions.set(document, (fontRevisions.get(document) ?? 0) + 1);
        this.invalidateLayouts(undefined, event?.type ?? "fonts");
      };
      document.fonts.addEventListener("loadingdone", changed);
      document.fonts.addEventListener("loadingerror", changed);
      this.releaseFonts = () => {
        document.fonts.removeEventListener("loadingdone", changed);
        document.fonts.removeEventListener("loadingerror", changed);
      };
    }
    if (typeof MutationObserver !== "undefined" && document?.documentElement) {
      this.mutations = new MutationObserver(records => {
        const affected = new Set<HTMLElement>();
        const typographyStyle = (text: string | null) => (text ?? "").split(";")
          .filter(declaration => /^\s*(?:font(?:-[\w-]+)?|line-height|letter-spacing|word-spacing|white-space|text-transform|tab-size|word-break|overflow-wrap|direction|writing-mode|--[\w-]+)\s*:/iu.test(declaration)).sort().join(";");
        for (const record of records) {
          const target = record.target as Element;
          if (record.attributeName === "style"
            && typographyStyle(record.oldValue) === typographyStyle(target.getAttribute("style"))) continue;
          for (const element of this.registrations.keys()) if (target.contains(element)) affected.add(element);
        }
        if (affected.size) this.invalidateLayouts(affected, "mutation");
      });
      this.mutations.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["class", "style"], attributeOldValue: true });
    }
    this.invalidateLayouts();
    if (this.registrations.size) this.resetResize();
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
    }, { root, rootMargin: "2400px 0px", threshold: 0 });
    this.intersection = observer;
    for (const element of this.registrations.keys()) observer.observe(element);
  }

  height(key: string, estimate: number, element?: HTMLElement | null): number {
    if (!element) return this.heights.get(key) ?? estimate;
    const value = this.measurements.get(key);
    const valid = value && this.same(value, this.context(element));
    const height = valid ? value.heightPx : estimate;
    if (timelineDiagnosticsEnabled()) recordTimelineDiagnostic("placeholder-height", {
      viewport: timelineDiagnosticId(this), row: timelineDiagnosticId(element),
      height, estimate, measured: value?.heightPx ?? null, fallback: !valid,
    });
    return height;
  }

  observe(element: HTMLElement, key: string, update: (visible: boolean) => void, refresh: () => void = () => undefined): () => void {
    if (this.disposed) return () => undefined;
    const entry: ContentRegistration = { key, update, refresh, context: this.context(element), visible: false, rendered: false };
    this.registrations.set(element, entry);
    if (!this.resize) this.resetResize();
    else this.resize.observe(element, { box: "border-box" });
    refresh();
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
    if (timelineDiagnosticsEnabled()) recordTimelineDiagnostic(rendered ? "content-mount" : "content-unmount", {
      viewport: timelineDiagnosticId(this), row: timelineDiagnosticId(element),
      measured: this.heights.get(entry.key) ?? null, height: element.getBoundingClientRect().height,
    });
    entry.rendered = rendered;
    // Placeholder widths remain observed; their heights are never captured.
  }

  /** User work outlives visibility. A later visibility observation may retire
   * the row after the selection/disclosure/focus has been released. */
  private protected(element: HTMLElement): boolean {
    return hasTimelineInteraction(element);
  }

  dispose(): void {
    this.disposed = true;
    this.intersection?.disconnect();
    this.resize?.disconnect();
    this.mutations?.disconnect();
    this.releaseFonts?.();
    this.mutations = null;
    this.releaseFonts = null;
    this.measurements.clear();
    this.intersection = null;
    this.resize = null;
    this.registrations.clear();
    this.heights.clear();
    this.root = null;
  }
}

/** Shared mount-retention policy: user work outlives viewport visibility. */
export function hasTimelineInteraction(element: HTMLElement): boolean {
  const document = element.ownerDocument;
  const selection = document.getSelection();
  return element.contains(document.activeElement)
    || Boolean(selection && !selection.isCollapsed && selection.rangeCount > 0
      && selection.getRangeAt(0).intersectsNode(element))
    || element.querySelector('[aria-expanded="true"], [data-open="true"], [data-mcp-app-expanded="true"]') !== null;
}
