import {
  computeBrowserViewportLayout, createBrowserPresentation, intersectBrowserPresentationBounds,
  type BrowserPageId, type BrowserPresentationSnapshot, type BrowserPresentationSurface,
  type BrowserTabId, type BrowserViewportLayout, type BrowserViewportMode,
} from "@opencraft/browser-core";
import type { WebBrowserPageRuntime } from "./web-browser-runtime";
import type { BrowserSurfaceHost } from "./web-browser-surface-host";
import { createCodexBrowserManager } from "./codex-browser-manager";
import { CodexPresentationHost } from "./codex-presentation-host";

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
  readonly host: CodexPresentationHost;
  readonly owner: string;
  readonly reference: object;
  viewportMode: BrowserViewportMode;
  lastLayoutKey: string;
  observer: ResizeObserver;
  removeEvents(): void;
  disposed: boolean;
}
const presentationIdFor = (input: PresentBrowserPageInput) =>
  `${input.viewId}\0${input.surface}\0${input.tabId}`;
const codexSurface = (surface: BrowserPresentationSurface) =>
  surface === "background" ? "hidden-browser-use" : surface === "fullscreen" ? "right-panel" : surface;

/** Layout adapter only. The imported Codex manager owns mounts, backing hosts
 * and the complete handoff state machine; no second timer/paint-owner loop. */
export class BrowserPresentationCoordinator {
  private readonly records = new Map<string, PresentationRecord>();
  private readonly pageSubscriptions = new Map<BrowserPageId, () => void>();
  private readonly useCounts = new Map<BrowserPageId, number>();
  readonly manager: ReturnType<typeof createCodexBrowserManager>;
  private readonly removeCloseListener: () => void;
  constructor(private readonly pages: WebBrowserPageRuntime, private readonly surfaces: BrowserSurfaceHost) {
    const Host = class extends CodexPresentationHost {
      constructor(options: Record<string, any>) {
        const pageId = options.browserTabId as BrowserPageId;
        surfaces.bindHostIdentity?.(pageId, { rendererInstanceId: options.rendererInstanceId, hostGeneration: options.hostGeneration });
        surfaces.bindStorageId?.(pageId, options.pagePersistence.browserStorageId);
        pages.prepareSurface(pageId);
        const port = surfaces.presentationPort?.(pageId);
        if (!port) throw new Error("Browser surface must supply a presentation host port");
        super(options, port);
      }
    };
    this.manager = createCodexBrowserManager(Host);
    surfaces.setBackingFactory?.(pageId => {
      const page = pages.getSnapshot(pageId);
      if (!page) throw new Error("Cannot create a backing without a logical Page owner");
      const storageId = surfaces.existingStorageId?.(pageId);
      if (storageId && !this.manager.getExistingBrowserStorageId(page.ownerId, pageId))
        this.manager.restorePersistedPageState(page.ownerId, pageId, storageId);
      const host = this.manager.getWebview(page.ownerId, pageId, page.navigation.currentUrl ?? "");
      if (!page.navigation.currentUrl) this.manager.setPrewarmedEmptyWebview(host, true);
    });
    surfaces.setUseFactory?.(pageId => {
      const page = pages.getSnapshot(pageId);
      if (!page) throw new Error("Browser page is closed");
      const host = this.manager.getWebview(page.ownerId, pageId, page.navigation.currentUrl ?? "") as CodexPresentationHost;
      const count = this.useCounts.get(pageId) ?? 0;
    if (count > 0) throw new Error("Browser page is busy with another automation operation");
      this.useCounts.set(pageId, 1);
      this.manager.setBrowserUseActive(page.ownerId, pageId, true);
      this.manager.setBrowserUseViewportSize(page.ownerId, pageId, { width: 1280, height: 800 });
      host.setAutomationActive(true);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.useCounts.delete(pageId);
        this.manager.setBrowserUseActive(page.ownerId, pageId, false);
        this.manager.releaseBrowserUseTab(page.ownerId, pageId);
        host.setAutomationActive(false);
      };
    });
    this.removeCloseListener = surfaces.onClose?.(pageId => {
      this.pageSubscriptions.get(pageId)?.(); this.pageSubscriptions.delete(pageId);
      for (const record of [...this.records.values()]) if (record.snapshot.pageId === pageId) this.disposeRecord(record);
      for (const [key, host] of this.manager.webviews) if (host.getBrowserTabId() === pageId)
        { this.manager.removeTab(host.getConversationId(), pageId); this.manager.disposeWebviewHost(host.getConversationId(), pageId, key, "closed"); }
    }) ?? (() => {});
  }
  getSnapshot(id: string): BrowserPresentationSnapshot | null {
    const record = this.records.get(id);
    return record ? { ...record.snapshot, phase: record.host.isPainted() ? "visible" : "parked" } : null;
  }
  present(input: PresentBrowserPageInput): BrowserPresentationHandle {
    const page = this.pages.getSnapshot(input.pageId);
    if (!page) throw new Error("Browser page is unavailable");
    const id = presentationIdFor(input);
    this.disposeRecord(this.records.get(id));
    const owner = page.ownerId;
    const savedStorage = this.surfaces.existingStorageId?.(input.pageId);
    if (savedStorage && !this.manager.getExistingBrowserStorageId(owner, input.pageId))
      this.manager.restorePersistedPageState(owner, input.pageId, savedStorage);
    const host = this.manager.getWebview(owner, input.pageId, page.navigation.currentUrl ?? "", { hostKind: input.surface }) as CodexPresentationHost;
    if (!this.pageSubscriptions.has(input.pageId)) {
      const syncSnapshot = () => {
        const current = this.pages.getSnapshot(input.pageId);
        if (current) this.manager.setSnapshot(owner, input.pageId, {
          ...current.navigation, url: current.navigation.currentUrl ?? "", title: current.title,
          tabType: current.navigation.currentUrl ? "web" : "new-tab-page",
        });
        if (current?.navigation.currentUrl) this.manager.setPrewarmedEmptyWebview(host, false);
      };
      this.pageSubscriptions.set(input.pageId, this.pages.subscribe(input.pageId, syncSnapshot));
      syncSnapshot();
    }
    const generation = this.manager.claimMountGeneration(owner, input.pageId, id);
    const snapshot = { ...createBrowserPresentation({ id, pageId: input.pageId, tabId: input.tabId,
      viewId: input.viewId, surface: input.surface }), generation };
    let record!: PresentationRecord;
    const measure = () => this.measureRecord(record);
    const observer = new ResizeObserver(measure);
    const aperture = input.slot.closest<HTMLElement>("[data-browser-presentation-aperture], .app-shell-right-panel__clip") ?? input.slot;
    record = { snapshot, slot: input.slot, aperture, host, owner, reference: {},
      viewportMode: input.viewportMode, lastLayoutKey: "", observer, disposed: false,
      removeEvents: () => { window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); } };
    this.records.set(id, record);
    observer.observe(input.slot);
    if (aperture !== input.slot) observer.observe(aperture);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    this.measureRecord(record);
    void host.whenReady().then(() => {
      if (this.records.get(id) === record && !record.disposed)
        this.manager.markWebviewAttached(owner, input.pageId, generation);
    });
    return {
      measure,
      updateViewportMode: mode => { if (!record.disposed) { record.viewportMode = mode; record.lastLayoutKey = ""; measure(); } },
      dispose: () => this.disposeRecord(record),
    };
  }
  dispose() {
    this.surfaces.setBackingFactory?.(null);
    this.surfaces.setUseFactory?.(null);
    this.removeCloseListener();
    for (const remove of this.pageSubscriptions.values()) remove();
    this.pageSubscriptions.clear();
    for (const record of [...this.records.values()]) this.disposeRecord(record);
    this.manager.disposeAll();
  }
  private measureRecord(record: PresentationRecord): void {
    if (record.disposed || this.records.get(record.snapshot.id) !== record) return;
    const slot = record.slot.getBoundingClientRect(), aperture = record.aperture.getBoundingClientRect();
    const bounds = intersectBrowserPresentationBounds(
      { x: slot.left, y: slot.top, width: slot.width, height: slot.height },
      { x: aperture.left, y: aperture.top, width: aperture.width, height: aperture.height },
      { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    );
    const layout = computeBrowserViewportLayout(bounds, record.viewportMode);
    this.manager.setDeviceToolbarTabState(record.owner, record.snapshot.pageId, () => ({
      responsiveViewportSize: { ...layout.viewportSize },
      toolbarState: { isEnabled: record.viewportMode.type !== "responsive",
        presetId: record.viewportMode.type === "device" ? record.viewportMode.presetId : "responsive", ...layout.viewportSize },
    }));
    const key = JSON.stringify(layout);
    if (record.lastLayoutKey === key) return;
    record.lastLayoutKey = key;
    record.snapshot = { ...record.snapshot, bounds: layout.visualBounds };
    this.manager.syncElectronWebview(record.host, {
      bounds: layout.visualBounds, layout, isVisible: bounds.width > 0 && bounds.height > 0,
      mountGeneration: record.snapshot.generation, scale: layout.scale, windowZoom: 1, shouldPaint: true,
    }, record.reference, codexSurface(record.snapshot.surface));
  }
  private disposeRecord(record: PresentationRecord | undefined): void {
    if (!record || record.disposed) return;
    record.disposed = true;
    record.observer.disconnect();
    record.removeEvents();
    this.records.delete(record.snapshot.id);
    this.manager.releaseMountGeneration(record.owner, record.snapshot.pageId, record.snapshot.id, record.snapshot.generation);
    // React releases the old effect before mounting the new panel in a commit.
    // Defer only the physical detach so the source handoff can retain outgoing.
    queueMicrotask(() => {
      if (record.host.getMountGeneration() !== record.snapshot.generation
        || this.manager.hasOtherMountGenerationClaim(record.owner, record.snapshot.pageId,
          record.snapshot.id, record.snapshot.generation)) return;
      this.manager.pagePresentationTransition.detach(record.host, record.reference,
        codexSurface(record.snapshot.surface), record.snapshot.generation);
    });
  }
}
