import {
  type BrowserAutomation,
  type BrowserPageId,
  type BrowserViewportLayout,
  type BrowserUrl,
} from "@opencraft/browser-core";
import {
  PreviewBridgeAdapter,
  installPreviewBridgeRuntime,
  type PreviewBridgeChildMessage,
} from "@opencraft/browser-preview-bridge";
import type { PresentationHostPort } from "./codex-presentation-host";

export interface BrowserSurfaceEvents {
  onNewWindow?(url: string, background: boolean): void;
  onNavigation?(state: { url: string; title: string; canGoBack: boolean; canGoForward: boolean; isLoading: boolean }): void;
  onLoaded(title: string | null): void;
  onError(message: string): void;
  onAutomationEvent(event: PreviewBridgeChildMessage): void;
}

export interface BrowserNewTabLabels { readonly title: string; readonly hint: string }

export interface BrowserSurfaceHost {
  setNewTabLabels?(labels: BrowserNewTabLabels): void;
  trackPointerNearBottom?(pageId: BrowserPageId, height: number, listener: (near: boolean) => void): () => void;
  setZoom?(pageId: BrowserPageId, percent: number): void;
  capture?(pageId: BrowserPageId): Promise<string>;
  setUseFactory?(factory: ((pageId: BrowserPageId) => () => void) | null): void;
  waitUntilReady?(pageId: BrowserPageId): Promise<void>;
  siteSettings?(pageId: BrowserPageId, action: "permissions" | "clear-data"): Promise<void>;
  clearClosedData?(): Promise<void>;
  forget?(pageId: BrowserPageId): void;
  acquireUse?(pageId: BrowserPageId): () => void;
  setBackingFactory?(factory: ((pageId: BrowserPageId) => void) | null): void;
  bindHostIdentity?(pageId: BrowserPageId, identity: { rendererInstanceId: string; hostGeneration: number }): void;
  existingStorageId?(pageId: BrowserPageId): string | null;
  bindStorageId?(pageId: BrowserPageId, storageId: string): void;
  presentationPort?(pageId: BrowserPageId): PresentationHostPort;
  onClose?(listener: (pageId: BrowserPageId) => void): () => void;
  readonly nativeNavigation?: boolean;
  goBack?(pageId: BrowserPageId): void;
  goForward?(pageId: BrowserPageId): void;
  setRoot(root: HTMLElement | null): void;
  navigate(pageId: BrowserPageId, title: string, url: BrowserUrl | null, events: BrowserSurfaceEvents, force?: boolean, trustedHostProxy?: boolean): boolean;
  stop(pageId: BrowserPageId): void;
  automation(pageId: BrowserPageId): BrowserAutomation | null;
  commit(pageId: BrowserPageId, layout: BrowserViewportLayout, phase: "staged" | "visible"): void;
  block(pageId: BrowserPageId): void;
  park(pageId: BrowserPageId): void;
  close(pageId: BrowserPageId): void;
  dispose(): void;
}

interface SurfaceRecord {
  readonly pageId: BrowserPageId;
  readonly container: HTMLDivElement;
  readonly iframe: HTMLIFrameElement;
  events: BrowserSurfaceEvents;
  loadedUrl: BrowserUrl | null;
  trustedHostProxy: boolean;
  automationGeneration: number;
  automation: BrowserAutomation | null;
  disposeInjectedRuntime: (() => void) | null;
}

const defaultNewTabLabels: BrowserNewTabLabels = { title: "New browser tab", hint: "Enter an address above to navigate" };
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
function newTabDocument(labels = defaultNewTabLabels) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="light dark">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(labels.title)}</title>
    <style>
      html,body{height:100%;margin:0}
      body{display:grid;place-items:center;background:#fff;color:#999;font:400 14px/20px "Inter Variable","PingFang SC","PingFang TC",-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;letter-spacing:-.01em;-webkit-font-smoothing:antialiased}
      .mark{display:grid;gap:10px;text-align:center}.icon{font-size:28px}.hint,.viewport{font-size:12px;color:#aaa}
      .viewport{font-variant-numeric:tabular-nums}
    </style>
  </head>
  <body>
    <div class="mark"><div class="icon">◎</div><div>${escapeHtml(labels.title)}</div>
      <div class="hint">${escapeHtml(labels.hint)}</div>
      <output class="viewport" id="viewport-size" aria-live="polite"></output></div>
    <script>
      const output=document.getElementById("viewport-size");
      const render=()=>{output.value=innerWidth+" × "+innerHeight};
      addEventListener("resize",render);render();
    </script>
  </body>
</html>`;
}

function setVisible(record: SurfaceRecord, visible: boolean): void {
  const { container, iframe } = record;
  iframe.dataset.browserSurfaceVisible = String(visible);
  iframe.setAttribute("aria-hidden", String(!visible));
  iframe.tabIndex = visible ? 0 : -1;
  container.style.opacity = visible ? "1" : "0";
  container.style.pointerEvents = visible ? "auto" : "none";
  container.style.visibility = "visible";
  container.style.zIndex = visible ? "1" : "0";
}

export function browserSurfaceSandboxForNavigation(trustedHostProxy: boolean): string | null {
  // Chromium does not consistently route sandboxed frame navigations through
  // the controlling Service Worker. A URL already authenticated as belonging
  // to this Workbench's Host proxy may therefore run without iframe sandboxing.
  // This exception must never be inferred from generic origin characteristics.
  if (trustedHostProxy) return null;
  const capabilities = [
    "allow-downloads",
    "allow-forms",
    "allow-modals",
    "allow-popups",
    "allow-popups-to-escape-sandbox",
    "allow-scripts",
  ];
  capabilities.push("allow-same-origin");
  return capabilities.join(" ");
}

function configureSandbox(iframe: HTMLIFrameElement, trustedHostProxy: boolean): void {
  const sandbox = browserSurfaceSandboxForNavigation(trustedHostProxy);
  if (sandbox === null) iframe.removeAttribute("sandbox");
  else iframe.setAttribute("sandbox", sandbox);
}

/** Web physical-page owner. It knows iframe mechanics, never Tabs or panel Views. */
export class WebIframeSurfaceHost implements BrowserSurfaceHost {
  private newTabLabels = defaultNewTabLabels;
  setNewTabLabels(labels: BrowserNewTabLabels): void {
    this.newTabLabels = labels;
    for (const record of this.surfaces.values()) {
      if (record.loadedUrl === null && record.iframe.hasAttribute("srcdoc")) {
        record.iframe.srcdoc = newTabDocument(labels);
      }
    }
  }
  trackPointerNearBottom(pageId: BrowserPageId, height: number, listener: (near: boolean) => void) {
    const record = this.surfaces.get(pageId);
    if (!record) return () => {};
    let detach = () => {};
    const attach = () => {
      detach();
      try {
        const child = record.iframe.contentWindow;
        if (!child) return;
        const move = (event: PointerEvent) => listener(event.clientY >= child.innerHeight - height);
        const leave = () => listener(false);
        child.addEventListener("pointermove", move);
        child.addEventListener("pointerleave", leave);
        detach = () => {
          try { child.removeEventListener("pointermove", move); child.removeEventListener("pointerleave", leave); }
          catch { /* Navigation may have replaced this same-origin document. */ }
        };
      } catch {
        // Cross-origin Web cannot inspect guest pointer events. Keyboard and
        // the browser toolbar remain available; desktop uses its native port.
        detach = () => {};
      }
    };
    attach(); record.iframe.addEventListener("load", attach);
    return () => { record.iframe.removeEventListener("load", attach); detach(); };
  }
  private readonly closeListeners = new Set<(pageId: BrowserPageId) => void>();
  onClose(listener: (pageId: BrowserPageId) => void) { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  presentationPort(pageId: BrowserPageId): PresentationHostPort {
    const record = this.require(pageId);
    return { container: record.container, guest: record.iframe, ready: Promise.resolve(),
      commit: (layout, visible) => this.commit(pageId, layout, visible ? "visible" : "staged"),
      park: () => this.park(pageId), close: () => this.close(pageId),
      cover: () => {}, clearCover: () => {} };
  }
  private readonly surfaces = new Map<BrowserPageId, SurfaceRecord>();
  private root: HTMLElement | null = null;

  setRoot(root: HTMLElement | null): void {
    this.root = root;
    if (root !== null) for (const surface of this.surfaces.values()) root.prepend(surface.container);
  }

  navigate(
    pageId: BrowserPageId,
    title: string,
    url: BrowserUrl | null,
    events: BrowserSurfaceEvents,
    force = false,
    trustedHostProxy = false,
  ): boolean {
    const record = this.ensure(pageId, title, events);
    record.events = events;
    if (url === null) {
      if (!force && record.loadedUrl === null && !record.trustedHostProxy
        && record.iframe.hasAttribute("srcdoc")) return false;
      record.loadedUrl = null;
      record.trustedHostProxy = false;
      configureSandbox(record.iframe, false);
      record.iframe.removeAttribute("src");
      record.iframe.srcdoc = newTabDocument(this.newTabLabels);
      return true;
    }
    if (!force && record.loadedUrl === url && record.trustedHostProxy === trustedHostProxy) return false;
    record.loadedUrl = url;
    record.trustedHostProxy = trustedHostProxy;
    configureSandbox(record.iframe, trustedHostProxy);
    record.iframe.removeAttribute("srcdoc");
    record.iframe.src = url;
    return true;
  }

  stop(pageId: BrowserPageId): void {
    try {
      this.surfaces.get(pageId)?.iframe.contentWindow?.stop();
    } catch {
      // Cross-origin frames may reject stop; Page state still settles.
    }
  }

  automation(pageId: BrowserPageId): BrowserAutomation | null {
    return this.surfaces.get(pageId)?.automation ?? null;
  }

  commit(pageId: BrowserPageId, layout: BrowserViewportLayout, phase: "staged" | "visible"): void {
    const record = this.require(pageId);
    const { container, iframe } = record;
    const { visualBounds, viewportSize, scale } = layout;
    container.dataset.browserViewportMode = scale === 1 ? "responsive" : "fixed";
    // Layout is measured in window coordinates. Embedded roots can establish
    // their own containing block, so place physical pages relative to that root.
    const origin = this.root?.getBoundingClientRect();
    container.style.left = `${visualBounds.x - (origin?.left ?? 0)}px`;
    container.style.top = `${visualBounds.y - (origin?.top ?? 0)}px`;
    container.style.width = `${visualBounds.width}px`;
    container.style.height = `${visualBounds.height}px`;
    iframe.style.left = "0px";
    iframe.style.top = "0px";
    iframe.style.width = `${viewportSize.width}px`;
    iframe.style.height = `${viewportSize.height}px`;
    iframe.style.transform = scale === 1 ? "" : `scale(${scale})`;
    iframe.style.transformOrigin = "top left";
    iframe.style.willChange = scale === 1 ? "" : "transform";
    setVisible(record, phase === "visible");
    if (phase === "staged") {
      container.style.opacity = "0.001";
      container.style.zIndex = "0";
    }
  }

  block(pageId: BrowserPageId): void {
    const container = this.surfaces.get(pageId)?.container;
    if (container !== undefined) container.style.pointerEvents = "none";
  }

  park(pageId: BrowserPageId): void {
    const record = this.surfaces.get(pageId);
    if (record !== undefined) setVisible(record, false);
  }

  close(pageId: BrowserPageId): void {
    const record = this.surfaces.get(pageId);
    if (record === undefined) return;
    record.automation?.dispose();
    record.disposeInjectedRuntime?.();
    record.container.remove();
    this.surfaces.delete(pageId);
    for (const listener of this.closeListeners) listener(pageId);
  }

  dispose(): void {
    for (const pageId of [...this.surfaces.keys()]) this.close(pageId);
    this.root = null;
  }

  private ensure(pageId: BrowserPageId, title: string, events: BrowserSurfaceEvents): SurfaceRecord {
    const existing = this.surfaces.get(pageId);
    if (existing !== undefined) return existing;
    const container = document.createElement("div");
    container.className = "web-browser-surface";
    container.dataset.browserPageId = pageId;
    const iframe = document.createElement("iframe");
    iframe.className = "web-browser-frame";
    iframe.dataset.browserPageId = pageId;
    iframe.title = title;
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    configureSandbox(iframe, false);
    const record: SurfaceRecord = {
      pageId,
      container,
      iframe,
      events,
      loadedUrl: null,
      trustedHostProxy: false,
      automationGeneration: 0,
      automation: null,
      disposeInjectedRuntime: null,
    };
    iframe.addEventListener("load", () => {
      if (this.surfaces.get(pageId) !== record) return;
      this.connectAutomation(record);
      let documentTitle: string | null = null;
      try {
        documentTitle = iframe.contentDocument?.title.trim() || null;
      } catch {
        // Cross-origin titles are unavailable to a Web iframe.
      }
      if (documentTitle !== null) iframe.title = documentTitle;
      record.events.onLoaded(documentTitle);
    });
    iframe.addEventListener("error", () => {
      if (this.surfaces.get(pageId) === record)
        record.events.onError("This page could not be embedded. Open it in an external browser.");
    });
    container.append(iframe);
    setVisible(record, false);
    this.surfaces.set(pageId, record);
    this.root?.prepend(container);
    return record;
  }

  private require(pageId: BrowserPageId): SurfaceRecord {
    const record = this.surfaces.get(pageId);
    if (record === undefined) throw new Error(`Browser surface ${pageId} is unavailable`);
    return record;
  }

  private connectAutomation(record: SurfaceRecord): void {
    record.automation?.dispose();
    record.disposeInjectedRuntime?.();
    record.automation = null;
    record.disposeInjectedRuntime = null;
    const frameWindow = record.iframe.contentWindow;
    if (frameWindow === null) return;
    const generation = ++record.automationGeneration;
    let targetOrigin: string;
    if (record.trustedHostProxy) {
      // Host proxy documents import the bridge injected by the Service Worker.
      // They are unsandboxed and same-origin, so both sides can use the exact
      // application origin; wildcard messaging is neither needed nor allowed.
      targetOrigin = window.location.origin;
    } else {
      try {
        targetOrigin = frameWindow.location.origin;
        // The initial about:blank load can race the requested navigation. It
        // has no serializable postMessage origin and owns no automation bridge.
        if (targetOrigin === "null") return;
        record.disposeInjectedRuntime = installPreviewBridgeRuntime({
          window: frameWindow,
          parentOrigin: window.location.origin,
        });
      } catch {
        if (record.loadedUrl === null) return;
        targetOrigin = new URL(record.loadedUrl).origin;
        if (targetOrigin === "null") return;
      }
    }
    record.automation = new PreviewBridgeAdapter({
      hostWindow: window,
      frameWindow,
      targetOrigin,
      previewId: record.pageId,
      generation,
      onEvent: (event) => {
        if (record.automationGeneration === generation) record.events.onAutomationEvent(event);
      },
    });
  }
}
