import { BrowserToolError, type BrowserDynamicToolContext } from "@opencraft/browser-appserver";
import {
  DEFAULT_BROWSER_VIEWPORT_MODE,
  normalizeBrowserViewportMode,
  parseBrowserUrl,
  type BrowserPageSnapshot,
  type BrowserTabId,
  type BrowserTabSnapshot,
  type BrowserViewportMode,
} from "@opencraft/browser-core";
import { createConversationKey, encodeConversationKey } from "@opencraft/chat-core";
import type { WorkbenchPanelService } from "@opencraft/workbench-panels";
import {
  type ConversationBindingStore,
  type ConversationScopeId,
} from "@opencraft/workbench-runtime";

import type { WebBrowserPageRuntime } from "./web-browser-runtime";

import type { BrowserMetadataStorage } from "./desktop-browser-storage";
import { browserMetadataKeys, readBrowserMetadataValue } from "@opencraft/workbench-runtime/browser-metadata-identity";
const STORAGE_KEY = browserMetadataKeys.tabs;

interface StoredBrowserTab {
  readonly id: string;
  readonly pageId: string;
  readonly ownerId: string;
  readonly createdAt: number;
  readonly viewportMode: unknown;
}

export interface BrowserConversationTab {
  readonly tabId: BrowserTabId;
  readonly ownerId: string;
  readonly title: string;
  readonly url: string | null;
}
const EMPTY_CONVERSATION_TABS: readonly BrowserConversationTab[] = [];

export interface BrowserTabWithPage {
  readonly tab: BrowserTabSnapshot;
  readonly page: BrowserPageSnapshot;
}

function createTabId(): BrowserTabId {
  const value = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `tab-${value}` as BrowserTabId;
}

/** Logical-tab owner. Pages own navigation; panels own chrome; Presentations own geometry. */
export class BrowserWorkbenchCoordinator {
  private readonly tabs = new Map<BrowserTabId, BrowserTabSnapshot>();
  private readonly tabListeners = new Map<BrowserTabId, Set<() => void>>();
  private readonly pageSubscriptions = new Map<BrowserTabId, () => void>();
  /** Panel projections are cache entries. Browser tabs remain application-owned. */
  private readonly panelOwners = new Map<BrowserTabId, Set<string>>();
  private readonly scopeByView = new Map<string, ConversationScopeId>();
  private readonly closingTabs = new Set<BrowserTabId>();
  private readonly resourceListeners = new Map<string, Set<() => void>>();
  private readonly resourceSnapshots = new Map<string, readonly BrowserConversationTab[]>();
  private readonly unsubscribeBindings: () => void;

  constructor(
    private readonly pages: WebBrowserPageRuntime,
    private readonly panels: WorkbenchPanelService,
    private readonly bindings: ConversationBindingStore,
    private readonly storage: BrowserMetadataStorage | null = null,
  ) {
    this.restoreTabs();
    this.unsubscribeBindings = bindings.subscribe(() => {
      for (const key of this.resourceListeners.keys()) {
        const [hostId, threadId] = JSON.parse(key);
        this.publishResources(hostId, threadId);
      }
    });
    this.pages.setNewWindowHandler((pageId, url, background) => {
      const source = [...this.tabs.values()].find(tab => tab.pageId === pageId);
      if (!source) return;
      this.open(source.ownerId, { initialUrl: url, background });
    });
  }

  getTabSnapshot = (tabId: BrowserTabId): BrowserTabSnapshot | null =>
    this.tabs.get(tabId) ?? null;

  subscribeTab = (tabId: BrowserTabId, listener: () => void): (() => void) => {
    if (!this.tabs.has(tabId)) return () => undefined;
    const listeners = this.tabListeners.get(tabId) ?? new Set<() => void>();
    listeners.add(listener);
    this.tabListeners.set(tabId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.tabListeners.delete(tabId);
    };
  };

  setViewportMode(tabId: BrowserTabId, viewportMode: BrowserViewportMode): void {
    const current = this.requireTab(tabId);
    this.tabs.set(tabId, { ...current, viewportMode });
    this.notifyTab(tabId);
    this.persistTabs();
  }

  pageForTab(tabId: BrowserTabId): BrowserPageSnapshot | null {
    const tab = this.tabs.get(tabId);
    return tab === undefined ? null : this.pages.getSnapshot(tab.pageId);
  }

  listForOwner(ownerId: string): readonly BrowserTabWithPage[] {
    return [...this.tabs.values()]
      .filter((tab) => tab.ownerId === ownerId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .flatMap((tab) => {
        const page = this.pages.getSnapshot(tab.pageId);
        return page === null ? [] : [{ tab, page }];
      });
  }

  /** Metadata only: listing a row must never initialize a browser surface. */
  getConversationTabs(hostId: string, threadId: string): readonly BrowserConversationTab[] {
    const key = JSON.stringify([hostId, threadId]);
    const ownerId = this.bindings.findScope(createConversationKey(hostId, threadId));
    const next = ownerId === null ? EMPTY_CONVERSATION_TABS : this.listForOwner(ownerId).map(({ tab, page }) => ({
      tabId: tab.id, ownerId: tab.ownerId, title: page.title, url: page.navigation.currentUrl,
    }));
    const previous = this.resourceSnapshots.get(key) ?? EMPTY_CONVERSATION_TABS;
    if (previous.length === next.length && previous.every((tab, i) => {
      const other = next[i]!;
      return tab.tabId === other.tabId && tab.ownerId === other.ownerId && tab.title === other.title && tab.url === other.url;
    })) return previous;
    this.resourceSnapshots.set(key, next);
    return next;
  }

  subscribeConversationTabs(hostId: string, threadId: string, listener: () => void): () => void {
    const key = JSON.stringify([hostId, threadId]);
    this.getConversationTabs(hostId, threadId);
    const listeners = this.resourceListeners.get(key) ?? new Set<() => void>();
    listeners.add(listener); this.resourceListeners.set(key, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) { this.resourceListeners.delete(key); this.resourceSnapshots.delete(key); } };
  }

  private publishResources(hostId: string, threadId: string): void {
    const key = JSON.stringify([hostId, threadId]), previous = this.resourceSnapshots.get(key) ?? EMPTY_CONVERSATION_TABS;
    if (this.getConversationTabs(hostId, threadId) !== previous)
      for (const listener of this.resourceListeners.get(key) ?? []) listener();
  }

  private publishOwnerResources(ownerId: string): void {
    const key = this.bindings.resolve(ownerId as ConversationScopeId)?.conversationKey;
    if (key) this.publishResources(key.hostId, key.threadId);
  }

  bindView(scopeId: ConversationScopeId, viewId: string): void {
    const currentScope = this.scopeByView.get(viewId);
    if (currentScope !== undefined && currentScope !== scopeId)
      throw new Error(`Browser View ${viewId} already belongs to Scope ${currentScope}`);
    this.scopeByView.set(viewId, scopeId);
    // Panel definitions reconstruct their cache from this resource directory.
    // Binding a physical View must not activate, reorder, or reopen a tab.
    this.panels.ensureOwner(scopeId);
    for (const { tab } of this.listForOwner(scopeId)) {
      const owners = this.panelOwners.get(tab.id) ?? new Set<string>();
      owners.add(scopeId);
      this.panelOwners.set(tab.id, owners);
      this.observeTab(tab.id);
    }
  }

  releasePanel(ownerId: string, tabId: BrowserTabId, closeResource = false): void {
    const owners = this.panelOwners.get(tabId);
    owners?.delete(ownerId);
    if (owners?.size === 0) this.panelOwners.delete(tabId);
    if (closeResource && !this.closingTabs.has(tabId)) this.destroyTab(tabId);
  }

  releaseView(viewId: string): void {
    this.scopeByView.delete(viewId);
  }

  scopeForThread(context: BrowserDynamicToolContext): ConversationScopeId {
    const key = createConversationKey(context.hostId, context.threadId);
    const existing = this.bindings.findScope(key);
    if (existing === null) {
      throw new BrowserToolError(
        "TAB_ACCESS_DENIED",
        `Thread ${encodeConversationKey(key)} has no active Conversation Scope`,
      );
    }
    return existing;
  }

  requireOwnedTab(ownerId: string, tabId: BrowserTabId): BrowserTabWithPage {
    const tab = this.tabs.get(tabId);
    if (tab === undefined)
      throw new BrowserToolError("TAB_NOT_FOUND", `Browser tab ${tabId} is unavailable`);
    if (tab.ownerId !== ownerId) {
      throw new BrowserToolError(
        "TAB_ACCESS_DENIED",
        `Browser tab ${tabId} belongs to another Conversation Scope`,
      );
    }
    const page = this.pages.getSnapshot(tab.pageId);
    if (page === null)
      throw new BrowserToolError("TAB_NOT_FOUND", `Browser page ${tab.pageId} is unavailable`);
    return { tab, page };
  }

  open(ownerId: string, options: {
    readonly initialUrl?: string;
    readonly storageId?: string;
    readonly tabId?: BrowserTabId;
    readonly panelOwnerId?: string;
    readonly hostId?: string;
    readonly background?: boolean;
    readonly visible?: boolean;
  } = {}) {
    const created = options.tabId === undefined;
    const normalizedUrl = options.initialUrl === undefined
      ? undefined
      : parseBrowserUrl(options.initialUrl);
    // Resolve access before an external navigation can have any side effects.
    const existingTab = options.tabId === undefined ? undefined : this.requireOwnedTab(ownerId, options.tabId).tab;
    if (normalizedUrl !== undefined && this.pages.openExternalIfRequired(normalizedUrl)) return null;
    let tab: BrowserTabSnapshot;
    if (existingTab === undefined) {
      const pageId = this.pages.create({
        ownerId,
        hostId: options.hostId
          ?? this.bindings.resolve(ownerId as ConversationScopeId)?.hostId
          ?? null,
        ...(normalizedUrl === undefined ? {} : { initialUrl: normalizedUrl }),
      });
      if (options.storageId) this.pages.bindStorage(pageId, options.storageId);
      tab = {
        id: createTabId(),
        pageId,
        ownerId,
        createdAt: Date.now(),
        viewportMode: DEFAULT_BROWSER_VIEWPORT_MODE,
      };
      this.tabs.set(tab.id, tab);
      this.persistTabs();
    } else {
      tab = existingTab;
    }
    try {
      const panelOwnerId = options.panelOwnerId ?? ownerId;
      const panelTab = options.visible === false ? null : this.presentTab(panelOwnerId, tab.id, !options.background);
      this.observeTab(tab.id);
      if (options.background || options.visible === false) this.pages.prepareSurface(tab.pageId);
      if (!created && normalizedUrl !== undefined) this.pages.navigate(tab.pageId, normalizedUrl);
      return { tabId: tab.id, pageId: tab.pageId, tab: panelTab };
    } catch (error) {
      if (created) this.destroyTab(tab.id);
      throw error;
    }
  }

  restorePersistedTabs(): void {
    const validPages = new Set(Array.from(this.tabs.values(), (tab) => tab.pageId));
    for (const page of this.pages.list()) {
      if (!validPages.has(page.id)) this.pages.close(page.id);
    }
    for (const tab of [...this.tabs.values()]) {
      const scopeId = tab.ownerId as ConversationScopeId;
      if (this.pages.getSnapshot(tab.pageId) === null) {
        this.destroyTab(tab.id);
        continue;
      }
      // Unresolved ownership is a restoration state, never a close command.
      if (this.bindings.resolve(scopeId) === null) continue;
      this.observeTab(tab.id);
    }
  }

  openResource(ownerId: string, lease: string, url: string | null) {
    const existing = [...this.tabs.values()].find(tab => this.pages.storageId(tab.pageId)?.replace(':', '-') === lease);
    if (existing) return this.open(existing.ownerId, { tabId: existing.id });
    return this.open(ownerId, { storageId: lease, ...(url ? { initialUrl: url } : {}) });
  }
  forgetResource(lease: string) {
    for (const tab of [...this.tabs.values()]) if (this.pages.storageId(tab.pageId)?.replace(':', '-') === lease) this.close(tab.ownerId, tab.id);
  }

  close(ownerId: string, tabId: BrowserTabId): void {
    this.requireOwnedTab(ownerId, tabId);
    this.closingTabs.add(tabId);
    const panelOwners = [...(this.panelOwners.get(tabId) ?? [])];
    this.panelOwners.delete(tabId);
    for (const panelOwnerId of panelOwners) {
      for (const region of ["right", "bottom"] as const) this.panels.close(panelOwnerId, region, `browser:${tabId}`);
    }
    this.closingTabs.delete(tabId);
    this.destroyTab(tabId);
  }

  disposeOwner(ownerId: string): void {
    for (const { tab } of [...this.listForOwner(ownerId)]) this.close(ownerId, tab.id);
  }

  dispose(): void {
    this.unsubscribeBindings(); this.resourceListeners.clear(); this.resourceSnapshots.clear();
    this.pages.setNewWindowHandler(null);
    for (const tabId of [...this.tabs.keys()]) this.stopObserving(tabId);
    this.panelOwners.clear();
    this.scopeByView.clear();
    this.tabListeners.clear();
  }

  private requireTab(tabId: BrowserTabId): BrowserTabSnapshot {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) throw new Error(`Browser tab ${tabId} is unavailable`);
    return tab;
  }

  private observeTab(tabId: BrowserTabId): void {
    if (this.pageSubscriptions.has(tabId)) return;
    const tab = this.requireTab(tabId);
    const synchronize = () => {
      const page = this.pages.getSnapshot(tab.pageId);
      if (page === null) return;
      this.publishOwnerResources(tab.ownerId);
      for (const panelOwnerId of this.panelOwners.get(tabId) ?? []) {
        for (const region of ["right", "bottom"] as const) {
        this.panels.dispatch(panelOwnerId, {
          type: "update-tab",
          region,
          tabId: `browser:${tabId}`,
          patch: { title: page.title },
        });
        }
      }
    };
    this.pageSubscriptions.set(tabId, this.pages.subscribe(tab.pageId, synchronize));
    synchronize();
  }

  private stopObserving(tabId: BrowserTabId): void {
    this.pageSubscriptions.get(tabId)?.();
    this.pageSubscriptions.delete(tabId);
  }

  private destroyTab(tabId: BrowserTabId): void {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) return;
    this.stopObserving(tabId);
    this.panelOwners.delete(tabId);
    this.tabs.delete(tabId);
    this.tabListeners.get(tabId)?.clear();
    this.tabListeners.delete(tabId);
    if (![...this.tabs.values()].some((candidate) => candidate.pageId === tab.pageId))
      this.pages.close(tab.pageId);
    this.persistTabs();
    this.publishOwnerResources(tab.ownerId);
  }

  private presentTab(panelOwnerId: string, tabId: BrowserTabId, activate: boolean) {
    const tab = this.requireTab(tabId);
    if (tab.ownerId !== panelOwnerId)
      throw new Error(`Browser tab ${tabId} does not belong to panel owner ${panelOwnerId}`);
    const panelTab = this.panels.open(
      panelOwnerId,
      "browser",
      { browserTabId: tabId },
      { activate },
    );
    const owners = this.panelOwners.get(tabId) ?? new Set<string>();
    owners.add(panelOwnerId);
    this.panelOwners.set(tabId, owners);
    return panelTab;
  }

  private notifyTab(tabId: BrowserTabId): void {
    for (const listener of this.tabListeners.get(tabId) ?? []) listener();
  }

  private persistTabs(): void {
    const stored: StoredBrowserTab[] = [...this.tabs.values()];
    try {
      (this.storage ?? window.localStorage).setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // Browser tabs remain valid in memory when storage is unavailable.
    }
  }

  restoreTabs(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readBrowserMetadataValue(this.storage ?? window.localStorage, STORAGE_KEY) ?? "[]");
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    for (const candidate of parsed) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const row = candidate as Partial<StoredBrowserTab>;
      if (typeof row.id !== "string" || typeof row.pageId !== "string"
        || typeof row.ownerId !== "string" || typeof row.createdAt !== "number") continue;
      const tab: BrowserTabSnapshot = {
        id: row.id as BrowserTabId,
        pageId: row.pageId as BrowserTabSnapshot["pageId"],
        ownerId: row.ownerId,
        createdAt: row.createdAt,
        viewportMode: normalizeBrowserViewportMode(row.viewportMode),
      };
      if (!this.tabs.has(tab.id)) this.tabs.set(tab.id, tab);
    }
  }
}
