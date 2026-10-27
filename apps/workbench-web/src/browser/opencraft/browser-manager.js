
export function createImplementation(ports) {
const window = ports.window ?? globalThis.window;
const document = ports.document ?? globalThis.document;
const {
  webviewTabKinds, DEFAULT_WEBVIEW_STATE, PagePresentationTransition,
  RESPONSIVE_PRESET_ID, areWebviewTabsEqual, createCompositeKey,
  getCompositeWebviewStorageKey, logger, messageRouterInstance,
  parseConversationBrowserTabKey, WebviewSidebarManager,
  unregisterWebviewHandler, hostBridge,
}=ports;
const defaultDeviceToolbarTabState={responsiveViewportSize:null,toolbarState:DEFAULT_WEBVIEW_STATE};
return class BrowserHostRegistry {
  listeners = new Set();
  browserUseCursorStates = new Map();
  snapshots = new Map();
  mediaTabs = [];
  ownerRoutePathsByConversation = new Map();
  browserUseActiveTabKeys = new Set();
  browserUseTabKeys = new Set();
  browserUseTabs = [];
  browserUseTabIdsKeysByConversation = new Map();
  browserUseViewportSizes = new Map();
  browserUseCaptureSurfaceSizes = new Map();
  tabCaptureActiveKeys = new Set();
  deviceToolbarTabStates = new Map();
  tabPersistenceStates = new Map();
  webviews = new Map();
  transferredWebviewKeys = new Set();
  pendingElectronTransfers = new Map();
  mountStates = new Map();
  registrationAttempts = new WeakMap();
  nextHostGeneration = 0;
  rendererInstanceId = crypto.randomUUID();
  rendererSessionRegistration = null;
  pagePresentationTransition = new PagePresentationTransition();
  prewarmedEmptyWebviews = new WeakSet();
  prewarmedEmptyWebview = null;

  constructor() {
    const listen = (topic, callback) => messageRouterInstance.subscribe(topic, callback);
    listen("browser-sidebar-state", value => this.setSnapshot(value.conversationId, value.browserTabId, value.snapshot));
    listen("browser-sidebar-browser-use-state", value => this.setBrowserUseActive(value.conversationId, value.browserTabId, value.isActive));
    listen("browser-sidebar-browser-use-page-released", value => this.releaseBrowserUseTab(value.conversationId, value.browserTabId));
    listen("browser-sidebar-browser-use-viewport", value => this.setBrowserUseViewportSize(value.conversationId, value.browserTabId, value.viewportSize));
    listen("browser-sidebar-browser-use-capture-surface", value => this.setBrowserUseCaptureSurfaceSize(value.conversationId, value.browserTabId, value.surfaceSize));
    listen("browser-sidebar-browser-use-cursor-state", value => this.setBrowserUseCursorState(value.conversationId, value.browserTabId, value));
    listen("browser-sidebar-tab-capture-state", value => this.setTabCaptureActive(value.conversationId, value.browserTabId, value.isActive));
    listen("browser-sidebar-destroy-webview", value => this.destroyWebviewAtHostRequest(value.conversationId, value.browserTabId, value.mountGeneration, value.reason, value.teardownId));
    listen("browser-sidebar-webview-attached", value => this.markWebviewAttached(value.conversationId, value.browserTabId, value.mountGeneration));
    window.addEventListener("focus", () => this.resyncAttachedWebviews());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.resyncAttachedWebviews();
    });
  }

  subscribe = listener => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  #key(owner, tab) { return createCompositeKey(owner, tab); }
  #host(owner, tab) { return this.webviews.get(this.#key(owner, tab)); }
  #log(message, safe, sensitive) {
    logger.info(message, sensitive === undefined ? { safe } : { safe, sensitive });
  }
  getSnapshot(owner, tab) { return this.snapshots.get(this.#key(owner, tab)) ?? null; }
  getMediaTabs() { return this.mediaTabs; }
  setConversationOwnerRoutePath(owner, path) {
    this.ownerRoutePathsByConversation.set(owner, path);
    const previous = this.mediaTabs;
    this.refreshMediaTabs();
    if (previous !== this.mediaTabs) this.emitMediaChange();
  }
  getBrowserStorageId(owner, tab) {
    const key = this.#key(owner, tab);
    if (!this.tabPersistenceStates.has(key)) {
      this.tabPersistenceStates.set(key, { browserStorageId: `browser:${crypto.randomUUID()}`, mode: "ephemeral" });
    }
    return this.tabPersistenceStates.get(key).browserStorageId;
  }
  getExistingBrowserStorageId(owner, tab) {
    return this.tabPersistenceStates.get(this.#key(owner, tab))?.browserStorageId ?? null;
  }
  restorePersistedPageState(owner, tab, browserStorageId) {
    const previous = this.tabPersistenceStates.get(this.#key(owner, tab));
    if (previous?.browserStorageId === browserStorageId && previous.mode === "restore-expected") return;
    this.tabPersistenceStates.set(this.#key(owner, tab), { browserStorageId, mode: "restore-expected" });
    this.emitChange();
  }
  setPersistentBrowserStorageId(owner, tab, browserStorageId) {
    const previous = this.tabPersistenceStates.get(this.#key(owner, tab));
    if (previous?.browserStorageId === browserStorageId && previous.mode === "persistent") return;
    this.tabPersistenceStates.set(this.#key(owner, tab), { browserStorageId, mode: "persistent" });
    this.emitChange();
  }
  getPagePersistence(owner, tab) {
    const browserStorageId = this.getBrowserStorageId(owner, tab);
    const key = this.#key(owner, tab), state = this.tabPersistenceStates.get(key);
    if (state.mode === "ephemeral") this.tabPersistenceStates.set(key, { browserStorageId, mode: "persistent" });
    return { browserStorageId, restore: state.mode === "restore-expected" ? "required" : "none" };
  }
  getBrowserUseCursorState(owner, tab) { return this.browserUseCursorStates.get(this.#key(owner, tab)) ?? null; }
  isBrowserUseActive(owner, tab) { return this.browserUseActiveTabKeys.has(this.#key(owner, tab)); }
  isBrowserUseTab(owner, tab) { return this.browserUseTabKeys.has(this.#key(owner, tab)); }
  getBrowserUseTabs() { return this.browserUseTabs; }
  getBrowserUseActiveBrowserTabId(owner) { return this.getLastConversationBrowserTabId(owner, this.browserUseActiveTabKeys); }
  getBrowserUseBrowserTabIdsKey(owner) { return this.browserUseTabIdsKeysByConversation.get(owner) ?? ""; }
  getConversationBrowserTabIds(owner) {
    return this.getConversationBrowserTabIdsFromKeys(owner, new Set([...this.webviews.keys(), ...this.browserUseTabKeys]));
  }
  getBrowserUseBrowserTabIds(owner) { return this.getConversationBrowserTabIdsFromKeys(owner, this.browserUseTabKeys); }
  getDeviceToolbarTabState(owner, tab) { return this.deviceToolbarTabStates.get(this.#key(owner, tab)) ?? defaultDeviceToolbarTabState; }
  getMountGeneration(owner, tab) { return this.mountStates.get(this.#key(owner, tab))?.generation ?? 0; }
  claimMountGeneration(owner, tab, claim) {
    const key = this.#key(owner, tab);
    let state = this.mountStates.get(key);
    if (!state) {
      state = { claimKeys: new Set(), generation: 0 };
      this.mountStates.set(key, state);
    }
    if (!state.claimKeys.size) state.generation++;
    state.claimKeys.add(claim);
    return state.generation;
  }
  hasOtherMountGenerationClaim(owner, tab, claim, generation) {
    const state = this.mountStates.get(this.#key(owner, tab));
    return !!state && state.generation === generation && [...state.claimKeys].some(key => key !== claim);
  }
  releaseMountGeneration(owner, tab, claim, generation) {
    const state = this.mountStates.get(this.#key(owner, tab));
    if (state?.generation === generation) state.claimKeys.delete(claim);
    return state?.generation ?? 0;
  }
  syncElectronWebview(host, state, reference, surface) {
    this.pagePresentationTransition.sync(host, state, reference, surface);
  }
  setPrewarmedEmptyWebview(host, active) {
    if (active) {
      this.prewarmedEmptyWebviews.add(host);
      this.prewarmedEmptyWebview = host;
    } else this.releasePrewarmedEmptyWebview(host);
  }
  focusWebview(owner, tab, allowed) { this.#host(owner, tab)?.focus(allowed); }
  hasWebviewFocus(owner, tab) { return this.#host(owner, tab)?.hasFocus() ?? false; }
  detachElectronWebview(host, reference, surface, generation) {
    this.pagePresentationTransition.detach(host, reference, surface, generation);
  }
  setDeviceToolbarTabState(owner, tab, update) {
    this.deviceToolbarTabStates.set(this.#key(owner, tab), update(this.getDeviceToolbarTabState(owner, tab)));
    this.emitChange();
  }
  setSnapshot(owner, tab, snapshot) {
    this.snapshots.set(this.#key(owner, tab), snapshot);
    this.refreshMediaTabs();
    this.emitChange();
  }
  #clearTab(key) {
    for (const collection of [this.snapshots, this.browserUseCursorStates, this.browserUseActiveTabKeys,
      this.browserUseTabKeys, this.browserUseViewportSizes, this.browserUseCaptureSurfaceSizes,
      this.tabCaptureActiveKeys, this.deviceToolbarTabStates, this.tabPersistenceStates,
      this.mountStates, this.pendingElectronTransfers]) collection.delete(key);
  }
  removeTab(owner, tab) {
    const key = this.#key(owner, tab), host = this.webviews.get(key);
    if (host) this.pagePresentationTransition.removeTab(host);
    this.#clearTab(key);
    this.syncBrowserUseTabKeys(owner);
    this.refreshBrowserUseTabs();
    this.refreshMediaTabs();
    this.emitChange();
  }
  getWebview(owner, tab, initialUrl, options = {}) {
    const key = this.#key(owner, tab), pagePersistence = this.getPagePersistence(owner, tab);
    let host = this.webviews.get(key);
    if (host) {
      host.setHostKind(options.hostKind ?? "right-panel");
      if (host.setPagePersistence(pagePersistence)) this.registerWebviewHost(host, pagePersistence);
      return host;
    }
    const hostKind = options.hostKind ?? "right-panel";
    host = new WebviewSidebarManager({
      browserTabId: tab, conversationId: owner, elementKey: key, hostKind,
      hostGeneration: ++this.nextHostGeneration, pagePersistence,
      partition: getCompositeWebviewStorageKey(owner, tab), rendererInstanceId: this.rendererInstanceId,
      adoptionLease: null, adoptedWebContentsId: null,
    });
    this.webviews.set(key, host);
    this.registerWebviewHost(host, pagePersistence);
    this.refreshMediaTabs();
    this.#log("IAB_LIFECYCLE renderer created browser sidebar webview", { browserTabId: tab, conversationId: owner, hostKind }, { initialUrl });
    this.emitChange();
    return host;
  }
  registerWebviewHost(host, pagePersistence) {
    const attempt = {};
    this.registrationAttempts.set(host, attempt);
    if (this.rendererSessionRegistration === null) {
      this.rendererSessionRegistration = hostBridge.browserSidebar.registerWebviewHostSession({ rendererInstanceId: this.rendererInstanceId }).catch(() => false);
    }
    const current = () => this.isCurrentWebviewHost(host) && this.registrationAttempts.get(host) === attempt;
    const register = async () => {
      try {
        if (!await this.rendererSessionRegistration) {
          if (current()) this.disposeCurrentWebviewHost(host);
          return;
        }
        if (!current()) return;
        const accepted = await hostBridge.browserSidebar.registerWebviewHost({
          browserTabId: host.getBrowserTabId(), conversationId: host.getConversationId(),
          hostGeneration: host.getHostGeneration(), pagePersistence, rendererInstanceId: this.rendererInstanceId,
        });
        if (!current()) return;
        if (accepted) { if (host.markRegistered()) this.emitChange(); }
        else this.disposeCurrentWebviewHost(host);
      } catch {
        if (current()) this.disposeCurrentWebviewHost(host);
      } finally {
        if (this.registrationAttempts.get(host) === attempt) this.registrationAttempts.delete(host);
      }
    };
    void register();
  }
  isCurrentWebviewHost(host) { return this.#host(host.getConversationId(), host.getBrowserTabId()) === host; }
  disposeCurrentWebviewHost(host) {
    if (this.isCurrentWebviewHost(host)) this.disposeWebviewHost(host.getConversationId(), host.getBrowserTabId(), this.#key(host.getConversationId(), host.getBrowserTabId()), this.getSnapshot(host.getConversationId(), host.getBrowserTabId())?.tabType ?? "web");
  }
  getCursorOverlayHost(owner, tab) { return this.#host(owner, tab)?.getCursorOverlayHost() ?? null; }
  setBrowserUseActive(owner, tab, active) {
    const key = this.#key(owner, tab);
    if (this.browserUseActiveTabKeys.has(key) === active) {
      this.#host(owner, tab)?.setBrowserUseActive(active);
      this.#log("IAB_LIFECYCLE renderer synced browser use webview state", { browserTabId: tab, conversationId: owner, isBrowserUseActive: active }, {});
      return;
    }
    if (active) {
      this.browserUseActiveTabKeys.add(key);
      this.browserUseTabKeys.add(key);
      this.browserUseCursorStates.delete(key);
    } else {
      this.browserUseActiveTabKeys.delete(key);
      const cursor = this.browserUseCursorStates.get(key);
      if (cursor) this.browserUseCursorStates.set(key, { visible: false, x: cursor.x, y: cursor.y });
    }
    this.#host(owner, tab)?.setBrowserUseActive(active);
    this.syncBrowserUseTabKeys(owner);
    this.refreshBrowserUseTabs();
    this.refreshMediaTabs();
    this.emitChange();
    this.#log("IAB_LIFECYCLE renderer synced browser use webview state", { browserTabId: tab, conversationId: owner, isBrowserUseActive: active }, {});
    if (!active) this.releaseDetachedPrewarmedEmptyWebview(owner, tab);
  }
  releaseBrowserUseTab(owner, tab) {
    const key = this.#key(owner, tab), existed = this.browserUseTabKeys.delete(key);
    this.browserUseActiveTabKeys.delete(key);
    for (const map of [this.browserUseCursorStates, this.browserUseViewportSizes, this.browserUseCaptureSurfaceSizes, this.deviceToolbarTabStates]) map.delete(key);
    this.#host(owner, tab)?.releaseBrowserUse();
    this.syncBrowserUseTabKeys(owner);
    this.refreshBrowserUseTabs();
    this.refreshMediaTabs();
    if (existed) this.emitChange();
    this.releaseDetachedPrewarmedEmptyWebview(owner, tab);
  }
  clearBrowserUseState() {
    for (const key of [...this.browserUseTabKeys]) {
      const { conversationId, browserTabId } = parseConversationBrowserTabKey(key);
      this.releaseBrowserUseTab(conversationId, browserTabId);
    }
  }
  setBrowserUseViewportSize(owner, tab, size) {
    const key = this.#key(owner, tab);
    if (size) {
      this.browserUseViewportSizes.set(key, size);
      this.setDeviceToolbarTabState(owner, tab, previous => ({ ...previous,
        responsiveViewportSize: size, toolbarState: { ...previous.toolbarState, isEnabled: true, presetId: RESPONSIVE_PRESET_ID, ...size } }));
    } else {
      this.browserUseViewportSizes.delete(key);
      this.setDeviceToolbarTabState(owner, tab, previous => ({ ...previous,
        toolbarState: { ...previous.toolbarState, isEnabled: false } }));
    }
    this.#host(owner, tab)?.setBrowserUseViewportSize(size);
  }
  setBrowserUseCaptureSurfaceSize(owner, tab, size) {
    const key = this.#key(owner, tab);
    if (size) this.browserUseCaptureSurfaceSizes.set(key, size);
    else this.browserUseCaptureSurfaceSizes.delete(key);
    this.#host(owner, tab)?.setBrowserUseCaptureSurfaceSize(size);
  }
  setBrowserUseCursorState(owner, tab, cursor) {
    const visible = cursor.visible;
    const { animateMovement, moveSequence, x, y } = cursor;
    const key = this.#key(owner, tab);
    const previous = this.browserUseCursorStates.get(key);
    if (!visible && !previous) return;
    const next = visible ? { animateMovement, moveSequence, visible, x, y } : { visible, x, y };
    if (areWebviewTabsEqual(previous, next)) return;
    this.browserUseCursorStates.set(key, next);
    this.emitChange();
  }
  setTabCaptureActive(owner, tab, active) {
    const key = this.#key(owner, tab);
    if (active) this.tabCaptureActiveKeys.add(key);
    else this.tabCaptureActiveKeys.delete(key);
    this.#host(owner, tab)?.setTabCaptureActive(active);
  }
  reassociateTabState(owner, tab, targetOwner, targetTab, targetRoutePath) {
    const oldKey = this.#key(owner, tab), newKey = this.#key(targetOwner, targetTab);
    const host = this.webviews.get(oldKey);
    for (const map of [this.snapshots, this.tabPersistenceStates, this.deviceToolbarTabStates, this.browserUseViewportSizes]) {
      if (map.has(oldKey)) { map.set(newKey, map.get(oldKey)); map.delete(oldKey); }
    }
    const mount = this.mountStates.get(oldKey);
    if (mount) {
      this.mountStates.delete(oldKey);
      this.mountStates.set(newKey, { claimKeys: new Set(), generation: mount.generation });
    }
    for (const set of [this.browserUseActiveTabKeys, this.browserUseTabKeys]) {
      if (set.delete(oldKey)) set.add(newKey);
    }
    this.browserUseCursorStates.delete(oldKey);
    this.browserUseCaptureSurfaceSizes.delete(oldKey);
    this.tabCaptureActiveKeys.delete(oldKey);
    if (host) {
      this.pagePresentationTransition.transferRoute(host);
      this.webviews.delete(oldKey);
      this.webviews.set(newKey, host);
      host.transfer({ conversationId: targetOwner, browserTabId: targetTab, elementKey: newKey, partition: getCompositeWebviewStorageKey(targetOwner, targetTab) });
      this.registerWebviewHost(host, this.getPagePersistence(targetOwner, targetTab));
    }
    this.transferredWebviewKeys.add(`${oldKey}\0${newKey}`);
    this.pendingElectronTransfers.set(newKey, { sourceBrowserTabId: tab, sourceConversationId: owner });
    this.syncBrowserUseTabKeys(owner);
    this.syncBrowserUseTabKeys(targetOwner);
    this.refreshBrowserUseTabs();
    this.refreshMediaTabs();
    this.emitChange();
    messageRouterInstance.dispatchMessage("browser-sidebar-command", { conversationId: owner, browserTabId: tab,
      command: { type: "transfer-conversation", targetBrowserTabId: targetTab, targetConversationId: targetOwner } });
    host?.resync();
    this.#log("IAB_LIFECYCLE renderer reassociated browser sidebar tab", { sourceBrowserTabId: tab, sourceConversationId: owner, targetBrowserTabId: targetTab, targetConversationId: targetOwner });
  }
  consumePendingElectronTransfer(owner, tab) {
    const transfer = this.peekPendingElectronTransfer(owner, tab);
    this.pendingElectronTransfers.delete(this.#key(owner, tab));
    return transfer;
  }
  peekPendingElectronTransfer(owner, tab) { return this.pendingElectronTransfers.get(this.#key(owner, tab)) ?? null; }
  disposeAll() {
    this.pagePresentationTransition.disposeAll();
    for (const host of this.webviews.values()) host.dispose();
    for (const collection of [this.listeners, this.browserUseCursorStates, this.snapshots,
      this.ownerRoutePathsByConversation, this.browserUseActiveTabKeys, this.browserUseTabKeys,
      this.browserUseTabIdsKeysByConversation, this.browserUseViewportSizes, this.browserUseCaptureSurfaceSizes,
      this.tabCaptureActiveKeys, this.deviceToolbarTabStates, this.tabPersistenceStates, this.webviews,
      this.transferredWebviewKeys, this.pendingElectronTransfers, this.mountStates]) collection.clear();
    this.mediaTabs = [];
    this.browserUseTabs = [];
    this.prewarmedEmptyWebview = null;
  }
  emitChange() { for (const listener of this.listeners) listener(); }
  emitMediaChange() { this.emitChange(); }
  resyncAttachedWebviews() { for (const host of this.webviews.values()) host.resync(); }
  disposeWebviewHost(owner, tab, key, reason) {
    const host = this.webviews.get(key);
    if (!host) return;
    this.pagePresentationTransition.disposeHost(host);
    this.registrationAttempts.delete(host);
    this.webviews.delete(key);
    this.releasePrewarmedEmptyWebview(host);
    host.dispose();
    this.refreshMediaTabs();
    this.#log("IAB_LIFECYCLE renderer removed browser sidebar webview", { browserTabId: tab, conversationId: owner, tabType: reason });
  }
  releasePrewarmedEmptyWebview(host) {
    this.prewarmedEmptyWebviews.delete(host);
    if (this.prewarmedEmptyWebview === host) this.prewarmedEmptyWebview = null;
    // Standard guests have no adoption registry to release. The logical Page
    // retains its backing; dropping a prewarm marker must not close that Page.
    return false;
  }
  releaseDetachedPrewarmedEmptyWebview(owner, tab) {
    const host = this.#host(owner, tab);
    if (host && this.prewarmedEmptyWebviews.has(host) && !host.isPainted() && !this.isBrowserUseTab(owner, tab)) this.releasePrewarmedEmptyWebview(host);
  }
  destroyWebviewAtHostRequest(owner, tab, mountGeneration, reason, teardownId) {
    const host = this.#host(owner, tab);
    if (host?.shouldDestroyForHostRequest({ mountGeneration, reason })) this.disposeWebviewHost(owner, tab, this.#key(owner, tab), reason);
    this.tabPersistenceStates.delete(this.#key(owner, tab));
    this.mountStates.delete(this.#key(owner, tab));
    messageRouterInstance.dispatchMessage("browser-sidebar-webview-destroyed", { browserTabId: tab, conversationId: owner, reason, teardownId });
  }
  getLastConversationBrowserTabId(owner, keys) { return this.getConversationBrowserTabIdsFromKeys(owner, keys).at(-1) ?? null; }
  getConversationBrowserTabIdsFromKeys(owner, keys) {
    const prefix = `${owner}\0`;
    return [...keys].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
  }
  removeConversationBrowserStateIfEmpty(owner) {
    if (!this.getConversationBrowserTabIds(owner).length) this.ownerRoutePathsByConversation.delete(owner);
  }
  syncBrowserUseTabKeys(owner) {
    const ids = this.getBrowserUseBrowserTabIds(owner);
    if (ids.length) this.browserUseTabIdsKeysByConversation.set(owner, ids.join("\0"));
    else this.browserUseTabIdsKeysByConversation.delete(owner);
  }
  refreshBrowserUseTabs() {
    const next = [...this.browserUseTabKeys].map(key => parseConversationBrowserTabKey(key));
    if (!areWebviewTabsEqual(this.browserUseTabs, next)) this.browserUseTabs = next;
  }
  refreshMediaTabs() {
    const next = [];
    for (const key of new Set([...this.webviews.keys(), ...this.browserUseTabKeys])) {
      const snapshot = this.snapshots.get(key);
      if (!snapshot || snapshot.tabType !== webviewTabKinds.WEB || !snapshot.url || !(snapshot.isAudible || snapshot.isCapturingUserMedia)) continue;
      const { conversationId, browserTabId } = parseConversationBrowserTabKey(key);
      next.push({ conversationId, browserTabId, faviconUrl: snapshot.faviconUrl, isAudioMuted: snapshot.isAudioMuted,
        isAudible: snapshot.isAudible, isCapturingCamera: snapshot.isCapturingCamera,
        isCapturingMicrophone: snapshot.isCapturingMicrophone, isCapturingUserMedia: snapshot.isCapturingUserMedia,
        isLoading: snapshot.isLoading, isWaitingForResponse: snapshot.isWaitingForResponse ?? false,
        ownerRoutePath: this.ownerRoutePathsByConversation.get(conversationId), title: snapshot.title, url: snapshot.url });
    }
    if (!areWebviewTabsEqual(this.mediaTabs, next)) this.mediaTabs = next;
  }
  removeConversationTabs(owner) {
    this.pagePresentationTransition.removeConversation(owner);
    for (const [key, host] of [...this.webviews]) {
      if (host.getConversationId() === owner) {
        this.registrationAttempts.delete(host);
        this.webviews.delete(key);
        this.releasePrewarmedEmptyWebview(host);
        host.dispose();
      }
    }
    const collections = [this.browserUseCursorStates, this.snapshots, this.browserUseActiveTabKeys,
      this.browserUseTabKeys, this.browserUseViewportSizes, this.browserUseCaptureSurfaceSizes,
      this.tabCaptureActiveKeys, this.deviceToolbarTabStates, this.tabPersistenceStates,
      this.mountStates, this.pendingElectronTransfers];
    for (const collection of collections) for (const key of [...collection.keys()]) if (key.startsWith(`${owner}\0`)) collection.delete(key);
    this.ownerRoutePathsByConversation.delete(owner);
    this.syncBrowserUseTabKeys(owner);
    this.refreshBrowserUseTabs();
    this.refreshMediaTabs();
  }
  markWebviewAttached(owner, tab, generation) {
    const host = this.#host(owner, tab);
    if (host) {
      this.pagePresentationTransition.acknowledgeAttachment(host, generation, this.getMountGeneration(owner, tab));
      unregisterWebviewHandler(owner, tab);
      this.emitChange();
    }
  }
};
}
