import {
  browserUrlTitle,
  createBrowserHistory,
  currentBrowserHistoryEntry,
  parseBrowserUrl,
  reduceBrowserHistory,
  type BrowserAutomation,
  type BrowserHistoryState,
  type BrowserPageId,
  type BrowserPageSnapshot,
  type BrowserUrl,
} from "@opencraft/browser-core";
import type { PreviewBridgeChildMessage } from "@opencraft/browser-preview-bridge";
import type { BrowserMetadataStorage } from "./desktop-browser-storage";

import {
  WebIframeSurfaceHost,
  type BrowserSurfaceEvents,
  type BrowserSurfaceHost,
} from "./web-browser-surface-host";

const STORAGE_KEY = "vela.browser-pages.v1";

interface StoredBrowserPage {
  readonly id: string;
  readonly ownerId: string;
  readonly hostId?: string | null;
  readonly createdAt: number;
  readonly entries: readonly { readonly url: string; readonly title: string }[];
  readonly index: number;
}

interface BrowserPageRecord {
  readonly id: BrowserPageId;
  readonly ownerId: string;
  readonly hostId: string | null;
  readonly createdAt: number;
  history: BrowserHistoryState;
  snapshot: BrowserPageSnapshot;
  readonly listeners: Set<() => void>;
}

export class WebBrowserCapabilityError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = "WebBrowserCapabilityError";
  }
}

export interface WebBrowserPageContext {
  readonly pageId: BrowserPageId;
  readonly url: string | null;
  readonly title: string;
  readonly revision: number;
  readonly selection: string | null;
  readonly content: string;
}

export interface WebBrowserInspectionElement {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly disabled: boolean;
}

export interface WebBrowserInspection {
  readonly pageId: BrowserPageId;
  readonly url: string | null;
  readonly title: string;
  readonly revision: number;
  readonly elements: readonly WebBrowserInspectionElement[];
}

export interface CreateWebBrowserPageInput {
  readonly ownerId: string;
  readonly hostId?: string | null;
  readonly initialUrl?: string;
}

export interface BrowserNavigationUrlMapper {
  toPhysicalUrl(url: BrowserUrl, hostId: string): BrowserUrl;
  toLogicalUrl(url: string, hostId: string): string;
  isPhysicalProxyUrl(url: string): boolean;
}

function createPageId(): BrowserPageId {
  const value = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `page-${value}` as BrowserPageId;
}

function createSnapshot(input: {
  readonly id: BrowserPageId;
  readonly ownerId: string;
  readonly createdAt: number;
  readonly history: BrowserHistoryState;
  readonly revision?: number;
  readonly isLoading?: boolean;
  readonly error?: string | null;
}): BrowserPageSnapshot {
  const current = currentBrowserHistoryEntry(input.history);
  return {
    revision: input.revision ?? 0,
    id: input.id,
    ownerId: input.ownerId,
    createdAt: input.createdAt,
    navigation: {
      currentUrl: current?.url ?? null,
      canGoBack: input.history.index > 0,
      canGoForward: input.history.index + 1 < input.history.entries.length,
      isLoading: input.isLoading ?? false,
    },
    title: current?.title ?? "New tab",
    error: input.error ?? null,
  };
}

/** Logical Page owner. It has no panel, iframe, WebContents or viewport state. */
export class WebBrowserPageRuntime {
  private readonly zoom = new Map<BrowserPageId, number>();
  get supportsZoom() { return !!this.surfaces.setZoom; }
  getZoom(pageId:BrowserPageId) { return this.zoom.get(pageId)??100; }
  setZoom(pageId:BrowserPageId,percent:number) {
    this.requireRecord(pageId);
    if(!Number.isFinite(percent)||percent<25||percent>500)throw new Error("Invalid page zoom");
    this.zoom.set(pageId,percent);
    this.surfaces.setZoom?.(pageId,percent);
  }
  private newWindowHandler: ((pageId: BrowserPageId, url: string, background: boolean) => void) | null = null;
  setNewWindowHandler(handler: ((pageId: BrowserPageId, url: string, background: boolean) => void) | null) { this.newWindowHandler = handler; }
  async siteSettings(pageId: BrowserPageId, action: "permissions" | "clear-data"): Promise<void> {
    if (!this.surfaces.siteSettings) throw new Error("网站设置仅在桌面浏览器可用");
    await this.surfaces.siteSettings(pageId, action);
  }
  get supportsSiteSettings() { return !!this.surfaces.siteSettings; }
  async clearClosedData() {
    if (!this.surfaces.clearClosedData) throw new Error("清理仅在桌面浏览器可用");
    await this.surfaces.clearClosedData();
  }
  async capturePage(pageId: BrowserPageId): Promise<string> {
    if (!this.surfaces.capture) throw new Error("截图仅在桌面浏览器可用");
    this.prepareSurface(pageId);
    const release = this.surfaces.acquireUse?.(pageId) ?? (() => {});
    try { await this.surfaces.waitUntilReady?.(pageId); return await this.surfaces.capture(pageId); }
    finally { release(); }
  }
  private readonly pages = new Map<BrowserPageId, BrowserPageRecord>();

  constructor(
    private readonly surfaces: BrowserSurfaceHost = new WebIframeSurfaceHost(),
    private readonly navigationMapper: BrowserNavigationUrlMapper | null = null,
    private readonly resolveOwnerHostId: (ownerId: string) => string | null = () => null,
    private readonly storage: BrowserMetadataStorage | null = null,
  ) {
    this.restore();
  }

  create(input: CreateWebBrowserPageInput): BrowserPageId {
    const id = createPageId();
    const createdAt = Date.now();
    let history = createBrowserHistory();
    if (input.initialUrl !== undefined) {
      const url = parseBrowserUrl(input.initialUrl);
      history = createBrowserHistory({ url, title: browserUrlTitle(url) });
    }
    this.pages.set(id, {
      id,
      ownerId: input.ownerId,
      hostId: input.hostId ?? this.resolveOwnerHostId(input.ownerId),
      createdAt,
      history,
      snapshot: createSnapshot({ id, ownerId: input.ownerId, createdAt, history }),
      listeners: new Set(),
    });
    this.persist();
    return id;
  }

  has(pageId: BrowserPageId): boolean {
    return this.pages.has(pageId);
  }

  listForOwner(ownerId: string): readonly BrowserPageSnapshot[] {
    return [...this.pages.values()].filter((record) => record.ownerId === ownerId)
      .sort((left, right) => left.createdAt - right.createdAt).map((record) => record.snapshot);
  }

  list(): readonly BrowserPageSnapshot[] {
    return [...this.pages.values()].sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => record.snapshot);
  }

  getSnapshot = (pageId: BrowserPageId): BrowserPageSnapshot | null =>
    this.pages.get(pageId)?.snapshot ?? null;

  subscribe = (pageId: BrowserPageId, listener: () => void): (() => void) => {
    const record = this.requireRecord(pageId);
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  };

  /** Materializes a physical surface without transferring Page ownership to it. */
  prepareSurface(pageId: BrowserPageId): void {
    const record = this.requireRecord(pageId);
    const current = currentBrowserHistoryEntry(record.history);
    const started = current === null
      ? this.surfaces.navigate(
          pageId,
          record.snapshot.title,
          null,
          this.surfaceEvents(record),
        )
      : this.load(record, current.url);
    if (started && current !== null && !record.snapshot.navigation.isLoading)
      this.publish(record, { isLoading: true, error: null });
  }

  navigate(pageId: BrowserPageId, input: string): BrowserUrl {
    const record = this.requireRecord(pageId);
    const url = parseBrowserUrl(input);
    record.history = reduceBrowserHistory(record.history, {
      type: "navigate",
      entry: { url, title: browserUrlTitle(url) },
    });
    this.publish(record, { isLoading: true, error: null });
    if (!this.load(record, url)) this.publish(record, { isLoading: false });
    this.persist();
    return url;
  }

  goBack(pageId: BrowserPageId): void {
    if (this.surfaces.nativeNavigation) this.surfaces.goBack?.(pageId);
    else this.moveHistory(pageId, "back");
  }
  goForward(pageId: BrowserPageId): void {
    if (this.surfaces.nativeNavigation) this.surfaces.goForward?.(pageId);
    else this.moveHistory(pageId, "forward");
  }

  reload(pageId: BrowserPageId): void {
    const record = this.requireRecord(pageId);
    const current = currentBrowserHistoryEntry(record.history);
    if (current === null) return;
    this.publish(record, { isLoading: true, error: null });
    this.load(record, current.url, true);
  }

  stop(pageId: BrowserPageId): void {
    const record = this.requireRecord(pageId);
    this.surfaces.stop(pageId);
    this.publish(record, { isLoading: false });
  }

  async readPageContext(pageId: BrowserPageId, options: {
    readonly includeSelection?: boolean;
    readonly maxInlineChars?: number;
  } = {}): Promise<WebBrowserPageContext> {
    const page = await this.withAutomation(pageId, automation => automation.readContext(options));
    return { pageId, ...page };
  }

  async inspectPage(pageId: BrowserPageId): Promise<WebBrowserInspection> {
    const inspection = await this.withAutomation(pageId, automation => automation.inspect());
    return { pageId, ...inspection };
  }

  async clickElement(pageId: BrowserPageId, ref: string, expectedRevision: number): Promise<void> {
    await this.withAutomation(pageId, automation => automation.click({ ref, expectedRevision }));
  }

  async fillElement(pageId: BrowserPageId, ref: string, expectedRevision: number, value: string): Promise<void> {
    await this.withAutomation(pageId, automation => automation.fill({ ref, expectedRevision, value }));
  }

  async pressKey(pageId: BrowserPageId, key: string): Promise<void> {
    await this.withAutomation(pageId, automation => automation.press({ key }));
  }

  async scrollPage(pageId: BrowserPageId, x: number, y: number): Promise<void> {
    await this.withAutomation(pageId, automation => automation.scroll({ x, y }));
  }

  async waitForText(pageId: BrowserPageId, text: string, timeoutMs: number): Promise<void> {
    await this.withAutomation(pageId, automation => automation.wait({ text, timeoutMs }));
  }

  close(pageId: BrowserPageId): void {
    this.zoom.delete(pageId);
    const record = this.pages.get(pageId);
    if (record === undefined) return;
    this.surfaces.close(pageId);
    this.surfaces.forget?.(pageId);
    this.pages.delete(pageId);
    record.listeners.clear();
    this.persist();
  }

  dispose(): void {
    for (const record of this.pages.values()) record.listeners.clear();
    this.pages.clear();
  }

  private requireRecord(pageId: BrowserPageId): BrowserPageRecord {
    const record = this.pages.get(pageId);
    if (record === undefined) throw new Error(`Browser page ${pageId} is unavailable`);
    return record;
  }

  private moveHistory(pageId: BrowserPageId, direction: "back" | "forward"): void {
    const record = this.requireRecord(pageId);
    const next = reduceBrowserHistory(record.history, { type: direction });
    if (next === record.history) return;
    record.history = next;
    const current = currentBrowserHistoryEntry(next);
    this.publish(record, { isLoading: current !== null, error: null });
    if (current !== null && !this.load(record, current.url)) this.publish(record, { isLoading: false });
    this.persist();
  }

  private load(record: BrowserPageRecord, url: BrowserUrl, force = false): boolean {
    const physicalUrl = record.hostId === null || this.navigationMapper === null
      ? url
      : this.navigationMapper.toPhysicalUrl(url, record.hostId);
    return this.surfaces.navigate(
      record.id,
      record.snapshot.title,
      physicalUrl,
      this.surfaceEvents(record),
      force,
      this.navigationMapper?.isPhysicalProxyUrl(physicalUrl) ?? false,
    );
  }

  private surfaceEvents(record: BrowserPageRecord): BrowserSurfaceEvents {
    return {
      onNewWindow: (url, background) => { if (this.pages.get(record.id) === record) this.newWindowHandler?.(record.id, url, background); },
      onNavigation: (state) => {
        if (this.pages.get(record.id) !== record || state.url === "about:blank") return;
        let url: BrowserUrl;
        try { url = parseBrowserUrl(state.url); } catch { return; }
        if (currentBrowserHistoryEntry(record.history)?.url !== url)
          record.history = reduceBrowserHistory(record.history, { type: "navigate", entry: { url, title: state.title || browserUrlTitle(url) } });
        record.snapshot = {
          ...record.snapshot, revision: record.snapshot.revision + 1,
          title: state.title || browserUrlTitle(url),
          error: null,
          navigation: { ...record.snapshot.navigation, currentUrl: url, canGoBack: state.canGoBack,
            canGoForward: state.canGoForward, isLoading: state.isLoading },
        };
        this.notify(record);
        this.persist();
      },
      onLoaded: (documentTitle) => {
        if (this.pages.get(record.id) !== record) return;
        const title = documentTitle
          ?? currentBrowserHistoryEntry(record.history)?.title
          ?? "New tab";
        record.snapshot = {
          ...record.snapshot,
          revision: record.snapshot.revision + 1,
          title,
          navigation: { ...record.snapshot.navigation, isLoading: false },
        };
        this.notify(record);
        this.persist();
      },
      onError: (message) => {
        if (this.pages.get(record.id) === record)
          this.publish(record, { isLoading: false, error: message });
      },
      onAutomationEvent: (event) => {
        if (this.pages.get(record.id) === record) this.onAutomationEvent(record, event);
      },
    };
  }

  private onAutomationEvent(record: BrowserPageRecord, event: PreviewBridgeChildMessage): void {
    if (event.type === "preview:url-changed") {
      try {
        const logicalUrl = record.hostId === null || this.navigationMapper === null
          ? event.url
          : this.navigationMapper.toLogicalUrl(event.url, record.hostId);
        const url = parseBrowserUrl(logicalUrl);
        record.history = reduceBrowserHistory(record.history, {
          type: "navigate",
          entry: { url, title: event.title || browserUrlTitle(url) },
        });
        record.snapshot = {
          ...createSnapshot({
            id: record.id,
            ownerId: record.ownerId,
            createdAt: record.createdAt,
            history: record.history,
            revision: record.snapshot.revision + 1,
            isLoading: false,
            error: null,
          }),
          title: event.title || browserUrlTitle(url),
        };
        this.notify(record);
        this.persist();
      } catch {
        // Internal/non-http child routes never weaken the Page URL policy.
      }
    } else if (event.type === "preview:error") {
      this.publish(record, { isLoading: false, error: event.message });
    }
  }

  private requireAutomation(pageId: BrowserPageId): BrowserAutomation {
    this.requireRecord(pageId);
    const automation = this.surfaces.automation(pageId);
    if (automation === null) {
      throw new WebBrowserCapabilityError(
        "PREVIEW_BRIDGE_UNAVAILABLE",
        "This page is presentation-only because it has not installed the OpenCraft Preview Bridge",
        true,
      );
    }
    return automation;
  }
  private async withAutomation<T>(pageId: BrowserPageId, call: (automation: BrowserAutomation) => Promise<T>): Promise<T> {
    this.prepareSurface(pageId);
    const release = this.surfaces.acquireUse?.(pageId) ?? (() => {});
    try {
      await this.surfaces.waitUntilReady?.(pageId);
      return await call(this.requireAutomation(pageId));
    } finally { release(); }
  }

  private publish(record: BrowserPageRecord, patch: {
    readonly isLoading?: boolean;
    readonly error?: string | null;
  }): void {
    const current = currentBrowserHistoryEntry(record.history);
    record.snapshot = {
      ...createSnapshot({
        id: record.id,
        ownerId: record.ownerId,
        createdAt: record.createdAt,
        history: record.history,
        revision: record.snapshot.revision + 1,
        isLoading: patch.isLoading ?? record.snapshot.navigation.isLoading,
        error: patch.error === undefined ? record.snapshot.error : patch.error,
      }),
      title: current?.title ?? record.snapshot.title,
    };
    this.notify(record);
  }

  private notify(record: BrowserPageRecord): void {
    for (const listener of record.listeners) listener();
  }

  private persist(): void {
    const stored: StoredBrowserPage[] = [...this.pages.values()].map((record) => ({
      id: record.id,
      ownerId: record.ownerId,
      hostId: record.hostId,
      createdAt: record.createdAt,
      entries: record.history.entries.map((entry) => ({ url: entry.url, title: entry.title })),
      index: record.history.index,
    }));
    try {
      (this.storage ?? window.localStorage).setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // Pages remain authoritative in memory when browser storage is unavailable.
    }
  }

  private restore(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse((this.storage ?? window.localStorage).getItem(STORAGE_KEY) ?? "[]");
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    for (const candidate of parsed) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const row = candidate as Partial<StoredBrowserPage>;
      if (typeof row.id !== "string" || typeof row.ownerId !== "string"
        || typeof row.createdAt !== "number" || !Array.isArray(row.entries)) continue;
      const entries = row.entries.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null || typeof (entry as { url?: unknown }).url !== "string") return [];
        try {
          const url = parseBrowserUrl((entry as { url: string }).url);
          const title = typeof (entry as { title?: unknown }).title === "string"
            ? (entry as { title: string }).title : browserUrlTitle(url);
          return [{ url, title }];
        } catch {
          return [];
        }
      });
      const index = entries.length === 0 ? -1 : Math.max(0, Math.min(Number(row.index) || 0, entries.length - 1));
      const id = row.id as BrowserPageId;
      const history = { entries, index } satisfies BrowserHistoryState;
      this.pages.set(id, {
        id,
        ownerId: row.ownerId,
        hostId: typeof row.hostId === "string" && row.hostId.trim()
          ? row.hostId
          : this.resolveOwnerHostId(row.ownerId),
        createdAt: row.createdAt,
        history,
        snapshot: createSnapshot({ id, ownerId: row.ownerId, createdAt: row.createdAt, history }),
        listeners: new Set(),
      });
    }
  }
}
