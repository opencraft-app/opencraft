import {
  claimBrowserPresentation,
  commitBrowserPresentation,
  computeBrowserViewportLayout,
  createBrowserPresentation,
  intersectBrowserPresentationBounds,
  parkBrowserPresentation,
  type BrowserPageId,
  type BrowserPresentationSnapshot,
  type BrowserPresentationSurface,
  type BrowserTabId,
  type BrowserViewportLayout,
  type BrowserViewportMode,
} from "@opencraft/browser-core";

import type { WebBrowserPageRuntime } from "./web-browser-runtime";
import type { BrowserSurfaceHost } from "./web-browser-surface-host";

const HANDOFF_TIMEOUT_MS = 100;
const PREWARM_FRAME_COUNT = 2;

export interface BrowserPresentationHandle {
  measure(): void;
  updateViewportMode(mode: BrowserViewportMode): void;
  dispose(): void;
}

export interface PresentBrowserPageInput {
  readonly pageId: BrowserPageId;
  readonly tabId: BrowserTabId;
  readonly viewId: string;
  readonly surface: BrowserPresentationSurface;
  readonly slot: HTMLElement;
  readonly viewportMode: BrowserViewportMode;
}

interface PresentationRecord {
  snapshot: BrowserPresentationSnapshot;
  readonly slot: HTMLElement;
  readonly aperture: HTMLElement;
  viewportMode: BrowserViewportMode;
  lastLayoutKey: string;
  lastLayout: BrowserViewportLayout | null;
  observer: ResizeObserver;
  frameId: number | null;
  timeoutId: number | null;
  disposed: boolean;
}

const presentationIdFor = (input: PresentBrowserPageInput) =>
  `${input.viewId}\0${input.surface}\0${input.tabId}`;

const surfaceKeyFor = (viewId: string, surface: BrowserPresentationSurface) =>
  `${viewId}\0${surface}`;

/**
 * Sole owner of Page -> View geometry and handoff. React supplies a slot; it
 * never moves, reveals or parks the iframe surface itself.
 */
export class BrowserPresentationCoordinator {
  private readonly records = new Map<string, PresentationRecord>();
  private readonly visibleBySurface = new Map<string, string>();
  private readonly visibleByPage = new Map<BrowserPageId, string>();

  constructor(
    private readonly pages: WebBrowserPageRuntime,
    private readonly surfaces: BrowserSurfaceHost,
  ) {}

  getSnapshot(id: string): BrowserPresentationSnapshot | null {
    return this.records.get(id)?.snapshot ?? null;
  }

  present(input: PresentBrowserPageInput): BrowserPresentationHandle {
    if (this.pages.getSnapshot(input.pageId) === null) {
      throw new Error(`Browser page ${input.pageId} is unavailable`);
    }
    this.pages.prepareSurface(input.pageId);
    const id = presentationIdFor(input);
    this.disposeRecord(this.records.get(id));
    const snapshot = claimBrowserPresentation(createBrowserPresentation({
      id,
      pageId: input.pageId,
      tabId: input.tabId,
      viewId: input.viewId,
      surface: input.surface,
    }));
    const aperture = input.slot.closest<HTMLElement>(
      "[data-browser-presentation-aperture], .app-shell-right-panel__clip",
    ) ?? input.slot;
    let record!: PresentationRecord;
    const observer = new ResizeObserver(() => this.measureRecord(record));
    record = {
      snapshot,
      slot: input.slot,
      aperture,
      viewportMode: input.viewportMode,
      lastLayoutKey: "",
      lastLayout: null,
      observer,
      frameId: null,
      timeoutId: null,
      disposed: false,
    };
    this.records.set(id, record);
    record.observer.observe(input.slot);
    if (aperture !== input.slot) record.observer.observe(aperture);

    const measure = () => this.measureRecord(record);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    this.measureRecord(record);
    this.beginHandoff(record);

    return {
      measure,
      updateViewportMode: (mode) => {
        if (record.disposed) return;
        record.viewportMode = mode;
        record.lastLayoutKey = "";
        this.measureRecord(record);
      },
      dispose: () => {
        window.removeEventListener("resize", measure);
        window.removeEventListener("scroll", measure, true);
        this.disposeRecord(record);
      },
    };
  }

  dispose(): void {
    for (const record of [...this.records.values()]) this.disposeRecord(record);
    this.records.clear();
    this.visibleBySurface.clear();
    this.visibleByPage.clear();
  }

  private measureRecord(record: PresentationRecord): void {
    if (record.disposed) return;
    const slot = record.slot.getBoundingClientRect();
    const aperture = record.aperture.getBoundingClientRect();
    const bounds = intersectBrowserPresentationBounds(
      { x: slot.left, y: slot.top, width: slot.width, height: slot.height },
      {
        x: aperture.left,
        y: aperture.top,
        width: aperture.width,
        height: aperture.height,
      },
      { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    );
    const layout = computeBrowserViewportLayout(bounds, record.viewportMode);
    const key = [
      layout.visualBounds.x,
      layout.visualBounds.y,
      layout.visualBounds.width,
      layout.visualBounds.height,
      layout.viewportSize.width,
      layout.viewportSize.height,
      layout.scale,
    ].join(":");
    if (record.lastLayoutKey === key) return;
    record.lastLayoutKey = key;
    record.lastLayout = layout;
    if (record.snapshot.phase === "visible") {
      record.snapshot = commitBrowserPresentation(
        record.snapshot,
        record.snapshot.generation,
        layout.visualBounds,
      );
      this.surfaces.commit(record.snapshot.pageId, layout, "visible");
    } else {
      this.surfaces.commit(record.snapshot.pageId, layout, "staged");
    }
  }

  private beginHandoff(incoming: PresentationRecord): void {
    const surfaceKey = surfaceKeyFor(
      incoming.snapshot.viewId,
      incoming.snapshot.surface,
    );
    const outgoingId = this.visibleBySurface.get(surfaceKey);
    const outgoing = outgoingId === undefined ? undefined : this.records.get(outgoingId);

    const previousForPageId = this.visibleByPage.get(incoming.snapshot.pageId);
    const previousForPage = previousForPageId === undefined
      ? undefined
      : this.records.get(previousForPageId);
    if (previousForPage !== undefined && previousForPage !== incoming) {
      this.park(previousForPage);
    }
    if (outgoing !== undefined && outgoing !== incoming) {
      this.surfaces.block(outgoing.snapshot.pageId);
    }
    if (incoming.lastLayout !== null) {
      this.surfaces.commit(incoming.snapshot.pageId, incoming.lastLayout, "staged");
    }

    const generation = incoming.snapshot.generation;
    const commit = () => {
      if (
        incoming.disposed
        || incoming.snapshot.generation !== generation
        || this.records.get(incoming.snapshot.id) !== incoming
      ) return;
      this.cancelSchedule(incoming);
      if (outgoing !== undefined && outgoing !== incoming) this.park(outgoing);
      const layout = incoming.lastLayout;
      if (layout === null) return;
      incoming.snapshot = commitBrowserPresentation(
        incoming.snapshot,
        generation,
        layout.visualBounds,
      );
      this.visibleBySurface.set(surfaceKey, incoming.snapshot.id);
      this.visibleByPage.set(incoming.snapshot.pageId, incoming.snapshot.id);
      this.surfaces.commit(incoming.snapshot.pageId, layout, "visible");
    };
    this.scheduleAfterFrames(incoming, PREWARM_FRAME_COUNT, commit);
    incoming.timeoutId = window.setTimeout(commit, HANDOFF_TIMEOUT_MS);
  }

  private scheduleAfterFrames(
    record: PresentationRecord,
    remaining: number,
    commit: () => void,
  ): void {
    if (remaining === 0) {
      commit();
      return;
    }
    record.frameId = window.requestAnimationFrame(() => {
      record.frameId = null;
      if (!record.disposed) this.scheduleAfterFrames(record, remaining - 1, commit);
    });
  }

  private park(record: PresentationRecord): void {
    record.snapshot = parkBrowserPresentation(
      record.snapshot,
      record.snapshot.generation,
    );
    if (this.visibleByPage.get(record.snapshot.pageId) === record.snapshot.id) {
      this.visibleByPage.delete(record.snapshot.pageId);
    }
    const surfaceKey = surfaceKeyFor(record.snapshot.viewId, record.snapshot.surface);
    if (this.visibleBySurface.get(surfaceKey) === record.snapshot.id) {
      this.visibleBySurface.delete(surfaceKey);
    }
    this.surfaces.park(record.snapshot.pageId);
  }

  private cancelSchedule(record: PresentationRecord): void {
    if (record.frameId !== null) window.cancelAnimationFrame(record.frameId);
    if (record.timeoutId !== null) window.clearTimeout(record.timeoutId);
    record.frameId = null;
    record.timeoutId = null;
  }

  private disposeRecord(record: PresentationRecord | undefined): void {
    if (record === undefined || record.disposed) return;
    record.disposed = true;
    this.cancelSchedule(record);
    record.observer.disconnect();
    this.park(record);
    if (this.records.get(record.snapshot.id) === record) {
      this.records.delete(record.snapshot.id);
    }
  }
}
