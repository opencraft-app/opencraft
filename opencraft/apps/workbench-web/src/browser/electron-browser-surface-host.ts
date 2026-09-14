import type { BrowserPageId, BrowserUrl, BrowserViewportLayout } from "@opencraft/browser-core";
import type { BrowserSurfaceEvents, BrowserSurfaceHost } from "./web-browser-surface-host";
import { createElectronBrowserAutomation } from "./electron-browser-automation";
import type { BrowserAutomation } from "@opencraft/browser-core";
import type { BrowserMetadataStorage } from "./desktop-browser-storage";
import type { PresentationHostPort } from "./codex-presentation-host";

interface Guest extends HTMLElement {
  setZoomFactor(factor: number): void;
  capturePage(): Promise<{ toDataURL(): string }>;
  getWebContentsId(): number;
  executeJavaScript(code: string): Promise<any>;
  src: string;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
}
interface Page {
  readonly container: HTMLDivElement;
  readonly guest: Guest;
  generation: number;
  events: BrowserSurfaceEvents;
  url: string;
  ready: boolean;
  zoomPercent?: number;
  documentGeneration: number;
  layout?: BrowserViewportLayout;
  phase?: "staged" | "visible" | "parked";
  automation?: BrowserAutomation;
  readyPromise: Promise<void>;
  resolveReady(): void;
  cover?: HTMLDivElement;
}
const STORAGE_KEY = "opencraft.browser-storage.v1";

/** Codex ownership model on standard Electron webview (no Owl adoption API).
 * Pages live in an application root, independently from React panel mounts.
 * A persisted logical page ID owns its storage partition; placement never does.
 */
export class ElectronBrowserSurfaceHost implements BrowserSurfaceHost {
  trackPointerNearBottom(id: BrowserPageId, height: number, listener: (near: boolean) => void) {
    const page = this.pages.get(id);
    const port = (window as any).opencraftDesktop?.browser;
    if (!page?.ready || !port?.trackPointer || !port?.onPointer) return () => {};
    const guestId = page.guest.getWebContentsId();
    const trackingId = crypto.randomUUID();
    const remove = port.onPointer((event: { guestId: number; trackingId: string; y: number; leave: boolean }) => {
      if (event.guestId !== guestId || event.trackingId !== trackingId || this.pages.get(id) !== page || page.phase !== "visible") return;
      const bounds = page.guest.getBoundingClientRect();
      listener(!event.leave && event.y >= bounds.height - height && event.y <= bounds.height);
    });
    void port.trackPointer(guestId, trackingId, true).catch(() => {});
    return () => { remove(); void port.trackPointer(guestId, trackingId, false).catch(() => {}); };
  }
  readonly nativeNavigation = true;
  private readonly pages = new Map<BrowserPageId, Page>();
  private root: HTMLDivElement | null = null;
  private readonly hostIdentities = new Map<BrowserPageId, { rendererInstanceId: string; hostGeneration: number }>();
  private readonly storageIds = new Map<string, string>();
  private backingFactory: ((id: BrowserPageId) => void) | null = null;
  private useFactory: ((id: BrowserPageId) => () => void) | null = null;
  setUseFactory(factory: ((id: BrowserPageId) => () => void) | null) { this.useFactory = factory; }
  acquireUse(id: BrowserPageId) { return this.useFactory?.(id) ?? (() => {}); }
  async capture(id: BrowserPageId) {
    const page = this.pages.get(id);
    if (!page?.ready) throw new Error("Browser page is not ready");
    const generation = page.documentGeneration;
    const image = await page.guest.capturePage();
    if (this.pages.get(id) !== page || page.documentGeneration !== generation) throw new Error("Browser page changed during capture");
    return image.toDataURL();
  }
  setZoom(id: BrowserPageId, percent: number) {
    const page=this.pages.get(id);
    if(!page)return;
    page.zoomPercent=percent;
    if(page.ready)page.guest.setZoomFactor(percent/100);
  }
  async waitUntilReady(id: BrowserPageId) {
    const page = this.pages.get(id);
    if (!page) throw new Error("Browser page is closed");
    if (!page.ready) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([page.readyPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Browser load timed out")), 15000); })]); }
      finally { clearTimeout(timer); }
    }
    if (this.pages.get(id) !== page || !page.ready) throw new Error("Browser document changed");
  }
  setBackingFactory(factory: ((id: BrowserPageId) => void) | null) { this.backingFactory = factory; }
  bindHostIdentity(id: BrowserPageId, identity: { rendererInstanceId: string; hostGeneration: number }) {
    this.hostIdentities.set(id, identity);
    const page = this.pages.get(id);
    if (page) {
      page.generation = identity.hostGeneration;
      page.guest.dataset.browserHostGeneration = String(identity.hostGeneration);
      page.guest.dataset.browserRendererInstanceId = identity.rendererInstanceId;
    }
  }
  existingStorageId(id: BrowserPageId) { return this.storageIds.get(id) ?? null; }
  bindStorageId(id: BrowserPageId, storageId: string) {
    if (!/^browser[:-][a-zA-Z0-9-]+$/.test(storageId)) throw new Error("Invalid browser storage identity");
    const current = this.storageIds.get(id);
    if (this.pages.has(id) && current !== storageId) throw new Error("Cannot replace a live browser partition");
    this.storageIds.set(id, storageId);
    this.storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.storageIds)));
  }
  private readonly closeListeners = new Set<(id: BrowserPageId) => void>();
  onClose(listener: (id: BrowserPageId) => void) { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  presentationPort(id: BrowserPageId): PresentationHostPort {
    const page = this.pages.get(id);
    if (!page) throw new Error("Browser backing is missing");
    return {
      container: page.container, guest: page.guest, ready: page.readyPromise,
      commit: (layout, visible) => this.commit(id, layout, visible ? "visible" : "staged"),
      park: () => this.park(id), close: () => this.close(id),
      clearCover: () => { page.cover?.remove(); page.cover = undefined; },
      cover: layout => {
        page.cover ??= document.createElement("div");
        const b = layout.visualBounds;
        Object.assign(page.cover.style, { position: "fixed", pointerEvents: "none",
          background: "var(--color-surface-tertiary, var(--color-surface, #fff))",
          left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, height: `${b.height}px`,
          zIndex: page.container.style.zIndex });
        page.container.before(page.cover);
      },
    };
  }

  constructor(private readonly storage: BrowserMetadataStorage = localStorage) {
    const port = (window as any).opencraftDesktop?.browser;
    this.removeNewWindowListener = port?.onNewWindow((event: { guestId: number; url: string; background: boolean }) => {
      for (const page of this.pages.values()) {
        if (page.ready && page.guest.getWebContentsId() === event.guestId) {
          page.events.onNewWindow?.(event.url, event.background);
          break;
        }
      }
    }) ?? (() => {});
    try {
      const saved = JSON.parse(this.storage.getItem(STORAGE_KEY) ?? "{}");
      for (const [page, storage] of Object.entries(saved)) {
        if (typeof storage === "string" && /^browser[:-][a-zA-Z0-9-]+$/.test(storage)) this.storageIds.set(page, storage);
      }
    } catch { /* Corrupt restore metadata cannot grant access to arbitrary partitions. */ }
  }
  private readonly removeNewWindowListener: () => void;
  async clearClosedData() { await (window as any).opencraftDesktop.browser.clearClosedData(); }
  async siteSettings(id: BrowserPageId, action: "permissions" | "clear-data") {
    const page = this.pages.get(id);
    if (!page?.ready) throw new Error("Browser page is not ready");
    await (window as any).opencraftDesktop.browser.siteSettings(page.guest.getWebContentsId(), action);
  }
  forget(id: BrowserPageId) {
    const retired = this.storageIds.get(id);
    if (retired) {
      const previous = JSON.parse(this.storage.getItem("opencraft.browser-retired-storage.v1") ?? "[]") as string[];
      this.storage.setItem("opencraft.browser-retired-storage.v1", JSON.stringify([...new Set([...previous, retired])]));
    }
    this.storageIds.delete(id);
    this.storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.storageIds)));
  }
  private storageId(id: BrowserPageId): string {
    const storage = this.storageIds.get(id);
    if (!storage) throw new Error("Browser manager has not assigned a storage identity");
    return storage;
  }

  setRoot(root: HTMLElement | null): void {
    // The React placeholder is not the backing owner. Only the source
    // manager may park a page; placeholder unmount cannot revoke its lease.
    if (root) this.ensureRoot();
  }
  private ensureRoot(): HTMLDivElement {
    if (!this.root) {
      this.root = document.createElement("div");
      this.root.className = "web-browser-presentation-root";
      this.root.dataset.desktopBrowserRoot = "";
      document.body.append(this.root);
    }
    return this.root;
  }
  navigate(id: BrowserPageId, title: string, url: BrowserUrl | null, events: BrowserSurfaceEvents, force = false): boolean {
    let page = this.pages.get(id);
    let createdByManager = false;
    if (!page && this.backingFactory && !this.hostIdentities.has(id)) {
      this.backingFactory(id);
      page = this.pages.get(id);
      createdByManager = !!page;
    }
    const target = url ?? "about:blank";
    if (!page) page = this.create(id, title, events);
    page.events = events;
    if (page.url === target) {
      if (force) {
        if (page.ready) page.guest.reload();
        else page.guest.src = target;
        return true;
      }
      return createdByManager;
    }
    page.url = target;
    if (page.ready) {
      const current = page;
      void page.guest.loadURL(target).catch((error: unknown) => {
        if (this.pages.get(id) === current && current.url === target
          && !String(error).includes("ERR_ABORTED")) current.events.onError("页面加载失败，请重试。");
      });
    } else page.guest.src = target;
    return true;
  }
  goBack(id: BrowserPageId) { const p = this.pages.get(id); if (p?.ready && p.guest.canGoBack()) p.guest.goBack(); }
  goForward(id: BrowserPageId) { const p = this.pages.get(id); if (p?.ready && p.guest.canGoForward()) p.guest.goForward(); }
  stop(id: BrowserPageId) { const p = this.pages.get(id); if (p?.ready) p.guest.stop(); }
  automation(id: BrowserPageId) { return this.pages.get(id)?.automation ?? null; }
  commit(id: BrowserPageId, layout: BrowserViewportLayout, phase: "staged" | "visible") {
    const p = this.pages.get(id);
    if (!p) return;
    p.layout = layout;
    p.phase = phase;
    const { visualBounds: b, viewportSize: viewport, scale } = layout;
    Object.assign(p.container.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, height: `${b.height}px` });
    Object.assign(p.guest.style, { width: `${viewport.width}px`, height: `${viewport.height}px`,
      transform: scale === 1 ? "" : `scale(${scale})`, transformOrigin: "top left" });
    const visible = phase === "visible";
    p.container.style.opacity = visible ? "1" : "0.001";
    p.container.style.pointerEvents = visible ? "auto" : "none";
    p.container.style.visibility = "visible";
    p.guest.tabIndex = visible ? 0 : -1;
    p.guest.setAttribute("aria-hidden", String(!visible));
    p.guest.dataset.browserSurfaceVisible = String(visible);
    // Focus belongs to the presentation host after the source transition
    // releases interaction, never to this low-level geometry commit.
  }
  block(id: BrowserPageId) { const p = this.pages.get(id); if (p) p.container.style.pointerEvents = "none"; }
  park(id: BrowserPageId) {
    const p = this.pages.get(id);
    if (!p) return;
    p.phase = "parked";
    p.container.style.opacity = "0";
    p.container.style.pointerEvents = "none";
    p.guest.tabIndex = -1;
    p.guest.setAttribute("aria-hidden", "true");
    p.guest.dataset.browserSurfaceVisible = "false";
    if (document.activeElement === p.guest) p.guest.blur();
  }
  close(id: BrowserPageId) {
    const p = this.pages.get(id);
    if (!p) return;
    this.pages.delete(id); // Fence late events before destroying the backing.
    this.hostIdentities.delete(id);
    p.resolveReady();
    p.cover?.remove();
    p.automation?.dispose();
    p.container.remove();
    for (const listener of this.closeListeners) listener(id);
  }
  dispose() {
    this.removeNewWindowListener();
    for (const id of this.pages.keys()) this.close(id);
    this.root?.remove(); this.root = null;
  }

  private create(id: BrowserPageId, title: string, events: BrowserSurfaceEvents): Page {
    if (!/^page-[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid browser page identity");
    const container = document.createElement("div");
    container.className = "web-browser-surface";
    container.style.backgroundColor = "var(--color-surface-tertiary, var(--color-surface, #fff))";
    container.dataset.browserPageId = id;
    const guest = document.createElement("webview") as Guest;
    guest.className = "web-browser-frame";
    guest.style.display = "flex"; // Electron webview's internal layout contract.
    guest.style.backgroundColor = "var(--color-surface-tertiary, var(--color-surface, #fff))";
    guest.title = title;
    guest.dataset.browserPageId = id;
    guest.setAttribute("partition", `persist:opencraft-browser:${this.storageId(id).replace("browser:", "browser-")}`);
    guest.dataset.browserRendererInstanceId = this.hostIdentities.get(id)?.rendererInstanceId ?? "";
    guest.setAttribute("webpreferences", "contextIsolation=yes,sandbox=yes,nodeIntegration=no");
    // Main intercepts every request and denies unmanaged native windows.
    guest.setAttribute("allowpopups", "");
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>(resolve => { resolveReady = resolve; });
    const page: Page = { container, guest, events, generation: this.hostIdentities.get(id)?.hostGeneration ?? 0, documentGeneration: 0, url: "", ready: false, readyPromise, resolveReady };
    guest.dataset.browserHostGeneration = String(page.generation);
    this.pages.set(id, page);
    const valid = () => this.pages.get(id) === page;
    const sync = () => {
      if (!valid() || !page.ready) return;
      try {
        const url = guest.getURL();
        if (url === "about:blank" && page.url && page.url !== "about:blank" && !page.ready) return;
        page.url = url;
        page.events.onNavigation?.({ url, title: guest.getTitle(), canGoBack: guest.canGoBack(),
          canGoForward: guest.canGoForward(), isLoading: guest.isLoading() });
      } catch { /* Guest may be tearing down between lifecycle notifications. */ }
    };
    guest.addEventListener("dom-ready", () => {
      if (!valid()) return;
      page.ready = true;
      if(page.zoomPercent)guest.setZoomFactor(page.zoomPercent/100);
      page.resolveReady();
      page.automation?.dispose();
      page.automation = guest.getURL().startsWith("http")
        ? createElectronBrowserAutomation(guest, id, page.generation) : undefined;
      sync();
    });
    guest.addEventListener("did-start-navigation", event => {
      const navigation = event as Event & { isMainFrame: boolean; isInPlace: boolean };
      if (valid() && navigation.isMainFrame && !navigation.isInPlace) {
        page.documentGeneration++;
        page.automation?.dispose(); page.automation = undefined;
      }
    });
    for (const event of ["did-navigate", "did-navigate-in-page", "page-title-updated", "did-start-loading", "did-stop-loading"]) guest.addEventListener(event, sync);
    guest.addEventListener("did-finish-load", () => {
      if (!valid()) return;
      sync();
      page.events.onLoaded(guest.getTitle() || null);
    });
    guest.addEventListener("did-fail-load", (event) => {
      const failure = event as Event & { errorCode: number; isMainFrame: boolean; validatedURL: string };
      if (valid() && failure.isMainFrame && failure.errorCode !== -3
        && (!failure.validatedURL || failure.validatedURL === page.url)) page.events.onError("页面加载失败，请重试或在系统浏览器中打开。");
    });
    guest.addEventListener("render-process-gone", () => {
      if (!valid()) return;
      page.automation?.dispose(); page.automation = undefined; page.ready = false;
      page.events.onError("浏览器页面进程已退出，请点击重新加载恢复。");
    });
    container.append(guest);
    this.park(id);
    this.ensureRoot().append(container);
    return page;
  }
}
