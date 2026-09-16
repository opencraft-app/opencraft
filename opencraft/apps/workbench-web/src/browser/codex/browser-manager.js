// Source class body copied from ref/codex/features/browser/browser-sidebar-webview-manager.ts.
// Changes are limited to dependency injection and eager class export.
export function createImplementation(ports) {
const window = ports.window ?? globalThis.window;
const document = ports.document ?? globalThis.document;
const {$l,DEFAULT_WEBVIEW_STATE,Jl,PagePresentationTransition,RESPONSIVE_PRESET_ID,VscodeWebviewMessageBus,areWebviewTabsEqual,bm,buildCacheKey,clampPanelWidth__rBr_2f54e,createCompositeKey__fN_2fpbe,createLoggerFacade,createWebviewHandoffManager,getCacheEntry__aVr_2fhgg,getCompositeWebviewStorageKey,getDefaultPanelWidth,getPendingWebviewAdoptionLease,getWebviewByKey,identityPassthrough,initializeAllModules__sd_bofx,initializeBrowserViewportPresets,initializeSidebarGlobalState,joinKeyWithNull,logger__Kp_mubr,messageRouterInstance,normalizeUrlOrEmpty,parseConversationBrowserTabKey,WebviewSidebarManager,browserSidebarWebviewModule,unregisterWebviewHandler,ym}=ports;
const WVr="default", UVr={responsiveViewportSize:null,toolbarState:DEFAULT_WEBVIEW_STATE};
return class {
        listeners = new Set;
        browserUseCursorStates = new Map;
        snapshots = new Map;
        mediaTabs = [];
        ownerRoutePathsByConversation = new Map;
        browserUseActiveTabKeys = new Set;
        browserUseTabKeys = new Set;
        browserUseTabs = [];
        browserUseTabIdsKeysByConversation = new Map;
        browserUseViewportSizes = new Map;
        browserUseCaptureSurfaceSizes = new Map;
        tabCaptureActiveKeys = new Set;
        deviceToolbarTabStates = new Map;
        tabPersistenceStates = new Map;
        webviews = new Map;
        transferredWebviewKeys = new Set;
        pendingElectronTransfers = new Map;
        mountStates = new Map;
        registrationAttempts = new WeakMap;
        nextHostGeneration = 0;
        rendererInstanceId = crypto.randomUUID();
        rendererSessionRegistration = null;
        pagePresentationTransition = new PagePresentationTransition;
        prewarmedEmptyWebviews = new WeakSet;
        prewarmedEmptyWebview = null;
        constructor(){
            messageRouterInstance.subscribe(`browser-sidebar-state`, (e)=>{
                this.setSnapshot(e.conversationId, e.browserTabId, e.snapshot);
            });
            messageRouterInstance.subscribe(`browser-sidebar-browser-use-state`, (e)=>{
                this.setBrowserUseActive(e.conversationId, e.browserTabId, e.isActive);
            });
            messageRouterInstance.subscribe(`browser-sidebar-browser-use-page-released`, (e)=>{
                this.releaseBrowserUseTab(e.conversationId, e.browserTabId);
            });
            messageRouterInstance.subscribe(`browser-sidebar-browser-use-viewport`, (e)=>{
                this.setBrowserUseViewportSize(e.conversationId, e.browserTabId, e.viewportSize);
            });
            messageRouterInstance.subscribe(`browser-sidebar-browser-use-capture-surface`, (e)=>{
                this.setBrowserUseCaptureSurfaceSize(e.conversationId, e.browserTabId, e.surfaceSize);
            });
            messageRouterInstance.subscribe(`browser-sidebar-browser-use-cursor-state`, (e)=>{
                this.setBrowserUseCursorState(e.conversationId, e.browserTabId, e);
            });
            messageRouterInstance.subscribe(`browser-sidebar-tab-capture-state`, (e)=>{
                this.setTabCaptureActive(e.conversationId, e.browserTabId, e.isActive);
            });
            messageRouterInstance.subscribe(`browser-sidebar-destroy-webview`, (e)=>{
                this.destroyWebviewAtHostRequest(e.conversationId, e.browserTabId, e.mountGeneration, e.reason, e.teardownId);
            });
            messageRouterInstance.subscribe(`browser-sidebar-webview-attached`, (e)=>{
                this.markWebviewAttached(e.conversationId, e.browserTabId, e.mountGeneration);
            });
            if (typeof window < `u`) {
                window.addEventListener(`focus`, ()=>{
                    this.resyncAttachedWebviews();
                });
            }
            if (typeof document < `u`) {
                document.addEventListener(`visibilitychange`, ()=>{
                    if (document.visibilityState === `visible`) {
                        this.resyncAttachedWebviews();
                    }
                });
            }
        }
        subscribe = (e)=>{
            this.listeners.add(e);
            return ()=>{
                this.listeners.delete(e);
            };
        };
        getSnapshot(e, t) {
            return this.snapshots.get(createCompositeKey__fN_2fpbe(e, t)) ?? null;
        }
        getMediaTabs() {
            return this.mediaTabs;
        }
        setConversationOwnerRoutePath(e, t) {
            if (this.ownerRoutePathsByConversation.get(e) !== t) {
                this.ownerRoutePathsByConversation.set(e, t);
                if (this.mediaTabs.some((t)=>t.conversationId === e)) {
                    this.emitMediaChange();
                }
            }
        }
        getBrowserStorageId(e, t) {
            let n = createCompositeKey__fN_2fpbe(e, t);
            let r = this.tabPersistenceStates.get(n);
            if (r != null) {
                return r.browserStorageId;
            }
            let i = identityPassthrough(`browser:${crypto.randomUUID()}`);
            this.tabPersistenceStates.set(n, {
                browserStorageId: i,
                mode: `ephemeral`
            });
            return i;
        }
        getExistingBrowserStorageId(e, t) {
            return this.tabPersistenceStates.get(createCompositeKey__fN_2fpbe(e, t))?.browserStorageId ?? null;
        }
        restorePersistedPageState(e, t, adoptionLease__n_2fs6o) {
            let r = createCompositeKey__fN_2fpbe(e, t);
            let i = this.tabPersistenceStates.get(r);
            if (!(i?.browserStorageId === adoptionLease__n_2fs6o && i.mode === `restore-expected`)) {
                this.tabPersistenceStates.set(r, {
                    browserStorageId: adoptionLease__n_2fs6o,
                    mode: `restore-expected`
                });
                this.emitChange();
            }
        }
        setPersistentBrowserStorageId(e, t, adoptedWebContentsId__n_2fsda) {
            let r = createCompositeKey__fN_2fpbe(e, t);
            let i = this.tabPersistenceStates.get(r);
            if (!(i?.browserStorageId === adoptedWebContentsId__n_2fsda && i.mode === `persistent`)) {
                this.tabPersistenceStates.set(r, {
                    browserStorageId: adoptedWebContentsId__n_2fsda,
                    mode: `persistent`
                });
                this.emitChange();
            }
        }
        getPagePersistence(e, t) {
            let n = createCompositeKey__fN_2fpbe(e, t);
            let r = this.tabPersistenceStates.get(n);
            if (r == null) {
                let browserStorageId = identityPassthrough(`browser:${crypto.randomUUID()}`);
                this.tabPersistenceStates.set(n, {
                    browserStorageId,
                    mode: `persistent`
                });
                return {
                    browserStorageId,
                    restore: `none`
                };
            }
            if (r.mode === `restore-expected`) {
                return {
                    browserStorageId: r.browserStorageId,
                    restore: `required`
                };
            }
            if (r.mode === `ephemeral`) {
                this.tabPersistenceStates.set(n, {
                    browserStorageId: r.browserStorageId,
                    mode: `persistent`
                });
            }
            return {
                browserStorageId: r.browserStorageId,
                restore: `none`
            };
        }
        getBrowserUseCursorState(e, t) {
            return this.browserUseCursorStates.get(createCompositeKey__fN_2fpbe(e, t)) ?? null;
        }
        isBrowserUseActive(e, t) {
            return this.browserUseActiveTabKeys.has(createCompositeKey__fN_2fpbe(e, t));
        }
        isBrowserUseTab(e, t) {
            return this.browserUseTabKeys.has(createCompositeKey__fN_2fpbe(e, t));
        }
        getBrowserUseTabs() {
            return this.browserUseTabs;
        }
        getBrowserUseActiveBrowserTabId(e) {
            return this.getLastConversationBrowserTabId(e, this.browserUseActiveTabKeys);
        }
        getBrowserUseBrowserTabIdsKey(e) {
            return this.browserUseTabIdsKeysByConversation.get(e) ?? ``;
        }
        getConversationBrowserTabIds(e) {
            let t = [];
            let n = new Set;
            let r = [
                this.browserUseTabKeys,
                this.webviews.keys()
            ];
            for (let i of r){
                for (let r of this.getConversationBrowserTabIdsFromKeys(e, i)){
                    if (!n.has(r)) {
                        n.add(r);
                        t.push(r);
                    }
                }
            }
            return t;
        }
        getBrowserUseBrowserTabIds(e) {
            return this.getConversationBrowserTabIdsFromKeys(e, this.browserUseTabKeys);
        }
        getDeviceToolbarTabState(e, t) {
            return this.deviceToolbarTabStates.get(createCompositeKey__fN_2fpbe(e, t)) ?? UVr;
        }
        getMountGeneration(e, t) {
            return this.mountStates.get(createCompositeKey__fN_2fpbe(e, t))?.generation ?? 0;
        }
        claimMountGeneration(e, t, n = WVr) {
            let r = createCompositeKey__fN_2fpbe(e, t);
            let i = this.mountStates.get(r) ?? {
                claimKeys: new Set,
                generation: 0
            };
            if (i.claimKeys.size === 0) {
                i.generation += 1;
            }
            i.claimKeys.add(n);
            this.mountStates.set(r, i);
            return i.generation;
        }
        hasOtherMountGenerationClaim(e, t, n = WVr, r) {
            let i = this.mountStates.get(createCompositeKey__fN_2fpbe(e, t));
            if (i == null || r != null && i.generation !== r) {
                return false;
            }
            for (let e of i.claimKeys){
                if (e !== n) {
                    return true;
                }
            }
            return false;
        }
        releaseMountGeneration(e, t, n = WVr, r) {
            let i = createCompositeKey__fN_2fpbe(e, t);
            let a = this.mountStates.get(i);
            if (a == null) {
                return 0;
            }
            if (!(r != null && a.generation !== r)) {
                a.claimKeys.delete(n);
            }
            return a.generation;
        }
        syncElectronWebview(e, t, n, r = `right-panel`) {
            this.pagePresentationTransition.sync(e, t, n, r);
        }
        setPrewarmedEmptyWebview(e, t) {
            if (!t) {
                if (this.prewarmedEmptyWebview === e) {
                    this.prewarmedEmptyWebview = null;
                }
                return;
            }
            if (this.prewarmedEmptyWebview != null && this.prewarmedEmptyWebview !== e) {
                this.releasePrewarmedEmptyWebview(this.prewarmedEmptyWebview);
            }
            this.prewarmedEmptyWebviews.add(e);
            this.prewarmedEmptyWebview = e;
        }
        focusWebview(e, t, n = ()=>true) {
            this.webviews.get(createCompositeKey__fN_2fpbe(e, t))?.focus(n);
        }
        hasWebviewFocus(e, t) {
            return this.webviews.get(createCompositeKey__fN_2fpbe(e, t))?.hasFocus() ?? false;
        }
        detachElectronWebview(e, t, n, r) {
            if (!(this.prewarmedEmptyWebviews.has(e) && (r == null || r === e.getMountGeneration()) && this.releasePrewarmedEmptyWebview(e))) {
                this.pagePresentationTransition.detach(e, t, n, r);
            }
        }
        setDeviceToolbarTabState(e, t, n) {
            let r = createCompositeKey__fN_2fpbe(e, t);
            this.deviceToolbarTabStates.set(r, n(this.getDeviceToolbarTabState(e, t)));
            this.emitChange();
        }
        setSnapshot(e, t, n) {
            let r = createCompositeKey__fN_2fpbe(e, t);
            this.snapshots.set(r, n);
            if (this.browserUseTabKeys.has(r)) {
                this.syncBrowserUseTabKeys(e);
            }
            this.emitMediaChange();
        }
        removeTab(e, t) {
            let n = createCompositeKey__fN_2fpbe(e, t);
            let r = this.webviews.get(n);
            if (r != null) {
                this.pagePresentationTransition.removeTab(r);
            }
            this.pendingElectronTransfers.delete(n);
            this.snapshots.delete(n);
            this.tabPersistenceStates.delete(n);
            let i = this.browserUseTabKeys.delete(n);
            this.browserUseActiveTabKeys.delete(n);
            this.browserUseCursorStates.delete(n);
            this.browserUseCaptureSurfaceSizes.delete(n);
            this.browserUseViewportSizes.delete(n);
            this.tabCaptureActiveKeys.delete(n);
            this.deviceToolbarTabStates.delete(n);
            this.mountStates.delete(n);
            if (i) {
                this.syncBrowserUseTabKeys(e);
            }
            this.emitMediaChange();
        }
        getWebview(e, t, n, r) {
            let i = createCompositeKey__fN_2fpbe(e, t);
            let a = this.getPagePersistence(e, t);
            let o = buildCacheKey(e, t);
            let s = this.webviews.get(i);
            let c = r?.hostKind ?? `right-panel`;
            if (s?.getPartition() === o) {
                s.setHostKind(c);
                if (s.setPagePersistence(a)) {
                    this.registerWebviewHost(s, a);
                    this.emitChange();
                }
                if (r != null) {
                    s.setAdoptionAttributes(r.adoptionLease ?? null, r.adoptedWebContentsId ?? null);
                    if (r.adoptionLease != null && r.adoptedWebContentsId != null) {
                        logger__Kp_mubr.info(`IAB_ADOPTION renderer updated adopted webview`, {
                            safe: {
                                adoptedWebContentsId: r.adoptedWebContentsId,
                                browserTabId: t,
                                conversationId: e,
                                hasInitialUrl: n.length > 0
                            },
                            sensitive: {}
                        });
                    }
                }
                return s;
            }
            if (s != null) {
                this.disposeWebviewHost(e, t, i, `web`);
            }
            let hostGeneration = ++this.nextHostGeneration;
            let u = new (WebviewSidebarManager)({
                browserTabId: t,
                conversationId: e,
                elementKey: getCompositeWebviewStorageKey(e, t),
                hostKind: c,
                hostGeneration,
                pagePersistence: a,
                partition: o,
                rendererInstanceId: this.rendererInstanceId,
                adoptionLease: r?.adoptionLease ?? null,
                adoptedWebContentsId: r?.adoptedWebContentsId ?? null
            });
            if (this.browserUseActiveTabKeys.has(i)) {
                u.setBrowserUseActive(true);
            }
            let d = this.browserUseViewportSizes.get(i) ?? null;
            if (d != null) {
                u.setBrowserUseViewportSize(d);
            }
            let f = this.browserUseCaptureSurfaceSizes.get(i) ?? null;
            if (f != null) {
                u.setBrowserUseCaptureSurfaceSize(f);
            }
            u.setTabCaptureActive(this.tabCaptureActiveKeys.has(i));
            this.webviews.set(i, u);
            this.registerWebviewHost(u, a);
            logger__Kp_mubr.info(`IAB_LIFECYCLE renderer created browser sidebar webview`, {
                safe: {
                    browserTabId: t,
                    conversationId: e,
                    hostKind: c
                },
                sensitive: {
                    initialUrl: n
                }
            });
            if (r?.adoptionLease != null && r.adoptedWebContentsId != null) {
                logger__Kp_mubr.info(`IAB_ADOPTION renderer created adopted webview`, {
                    safe: {
                        adoptedWebContentsId: r.adoptedWebContentsId,
                        browserTabId: t,
                        conversationId: e,
                        hasInitialUrl: n.length > 0
                    },
                    sensitive: {}
                });
            }
            this.emitMediaChange();
            return u;
        }
        registerWebviewHost(e, pagePersistence) {
            let n = ym?.browserSidebar;
            if (n == null) {
                this.disposeCurrentWebviewHost(e);
                return;
            }
            let r = e.getBrowserTabId();
            let i = e.getConversationId();
            let a = {};
            this.registrationAttempts.set(e, a);
            this.rendererSessionRegistration ??= n.registerWebviewHostSession({
                rendererInstanceId: this.rendererInstanceId
            });
            this.rendererSessionRegistration.then((o)=>{
                if (o && this.registrationAttempts.get(e) === a) {
                    return n.registerWebviewHost({
                        browserTabId: r,
                        conversationId: i,
                        hostGeneration: e.getHostGeneration(),
                        pagePersistence,
                        rendererInstanceId: this.rendererInstanceId
                    });
                }
                return false;
            }).then((t)=>{
                this.registrationAttempts.get(e) !== a || !this.isCurrentWebviewHost(e) || e.getBrowserTabId() !== r || e.getConversationId() !== i || (t ? e.markRegistered() && this.emitChange() : (this.disposeCurrentWebviewHost(e), this.emitMediaChange()));
            }).catch(()=>{
                if (!(this.registrationAttempts.get(e) !== a || !this.isCurrentWebviewHost(e))) {
                    this.disposeCurrentWebviewHost(e);
                    this.emitMediaChange();
                }
            });
        }
        isCurrentWebviewHost(e) {
            return this.webviews.get(createCompositeKey__fN_2fpbe(e.getConversationId(), e.getBrowserTabId())) === e;
        }
        disposeCurrentWebviewHost(e) {
            let t = e.getConversationId();
            let n = e.getBrowserTabId();
            let r = createCompositeKey__fN_2fpbe(t, n);
            if (this.webviews.get(r) === e) {
                this.disposeWebviewHost(t, n, r, `web`);
            }
        }
        getCursorOverlayHost(e, t) {
            return this.webviews.get(createCompositeKey__fN_2fpbe(e, t))?.getCursorOverlayHost() ?? null;
        }
        setBrowserUseActive(e, t, n) {
            let r = createCompositeKey__fN_2fpbe(e, t);
            let i = this.browserUseActiveTabKeys.has(r);
            let a = this.browserUseTabKeys.has(r);
            let o = this.browserUseCursorStates.get(r) ?? null;
            if (n) {
                this.browserUseTabKeys.add(r);
                if (!a) {
                    this.syncBrowserUseTabKeys(e);
                }
                this.browserUseActiveTabKeys.add(r);
                if (!i) {
                    this.browserUseCursorStates.delete(r);
                }
            } else {
                this.browserUseActiveTabKeys.delete(r);
                if (o != null) {
                    this.browserUseCursorStates.set(r, {
                        visible: false,
                        x: o.x,
                        y: o.y
                    });
                }
            }
            this.webviews.get(r)?.setBrowserUseActive?.(n);
            logger__Kp_mubr.info(`IAB_LIFECYCLE renderer synced browser use webview state`, {
                safe: {
                    browserTabId: t,
                    conversationId: e,
                    isBrowserUseActive: n
                },
                sensitive: {}
            });
            (i !== n || o != null) && (n && !a ? this.emitMediaChange() : this.emitChange());
        }
        releaseBrowserUseTab(e, t) {
            let n = createCompositeKey__fN_2fpbe(e, t);
            let r = this.browserUseActiveTabKeys.delete(n);
            let i = this.browserUseTabKeys.delete(n);
            let a = this.browserUseCursorStates.delete(n);
            let o = this.browserUseCaptureSurfaceSizes.delete(n);
            let s = this.browserUseViewportSizes.delete(n);
            let c = this.deviceToolbarTabStates.delete(n);
            let l = r || i || a || o || s || c;
            this.webviews.get(n)?.releaseBrowserUse();
            if (i) {
                this.syncBrowserUseTabKeys(e);
            }
            this.releaseDetachedPrewarmedEmptyWebview(e, t);
            l && (i ? this.emitMediaChange() : this.emitChange());
        }
        clearBrowserUseState() {
            let commandHandlerMap = new Set([
                ...this.browserUseTabKeys,
                ...this.browserUseActiveTabKeys,
                ...this.browserUseCursorStates.keys(),
                ...this.browserUseCaptureSurfaceSizes.keys(),
                ...this.browserUseViewportSizes.keys()
            ]);
            for (let t of commandHandlerMap){
                let { browserTabId: e, conversationId: n } = parseConversationBrowserTabKey(t);
                this.releaseBrowserUseTab(n, e);
            }
        }
        setBrowserUseViewportSize(e, path__t_2fynw, n) {
            let r = createCompositeKey__fN_2fpbe(e, path__t_2fynw);
            let i = n == null ? null : {
                width: clampPanelWidth__rBr_2f54e(n.width),
                height: getDefaultPanelWidth(n.height)
            };
            if (i == null) {
                this.browserUseViewportSizes.delete(r);
            } else {
                this.browserUseViewportSizes.set(r, i);
            }
            this.webviews.get(r)?.setBrowserUseViewportSize?.(i);
            this.setDeviceToolbarTabState(e, path__t_2fynw, (e)=>{
                if (i == null) {
                    return {
                        ...e,
                        toolbarState: {
                            ...e.toolbarState,
                            isEnabled: false
                        }
                    };
                }
                return {
                    responsiveViewportSize: i,
                    toolbarState: {
                        ...e.toolbarState,
                        ...i,
                        isEnabled: true,
                        presetId: RESPONSIVE_PRESET_ID
                    }
                };
            });
        }
        setBrowserUseCaptureSurfaceSize(e, t, n) {
            let r = createCompositeKey__fN_2fpbe(e, t);
            if (n == null) {
                this.browserUseCaptureSurfaceSizes.delete(r);
            } else {
                this.browserUseCaptureSurfaceSizes.set(r, n);
            }
            this.webviews.get(r)?.setBrowserUseCaptureSurfaceSize(n);
        }
        setBrowserUseCursorState(e, t, n) {
            let r = createCompositeKey__fN_2fpbe(e, t);
            let i = this.browserUseCursorStates.get(r);
            if (n.visible) {
                if (i?.visible === n.visible && i.animateMovement === n.animateMovement && i.moveSequence === n.moveSequence && i.x === n.x && i.y === n.y) {
                    return;
                }
                this.browserUseCursorStates.set(r, {
                    animateMovement: n.animateMovement,
                    moveSequence: n.moveSequence,
                    visible: true,
                    x: n.x,
                    y: n.y
                });
                this.emitChange();
                return;
            }
            if (!(i == null || !i.visible)) {
                this.browserUseCursorStates.set(r, {
                    visible: false,
                    x: i.x,
                    y: i.y
                });
                this.emitChange();
            }
        }
        setTabCaptureActive(e, t, n) {
            let r = createCompositeKey__fN_2fpbe(e, t);
            if (n) {
                this.tabCaptureActiveKeys.add(r);
            } else {
                this.tabCaptureActiveKeys.delete(r);
            }
            this.webviews.get(r)?.setTabCaptureActive(n);
            if (!n) {
                this.releaseDetachedPrewarmedEmptyWebview(e, t);
            }
        }
        reassociateTabState(e, t, n, r, i) {
            let a = joinKeyWithNull(createCompositeKey__fN_2fpbe(e, t), createCompositeKey__fN_2fpbe(n, r));
            let o = createCompositeKey__fN_2fpbe(e, t);
            let s = createCompositeKey__fN_2fpbe(n, r);
            if (o === s || this.transferredWebviewKeys.has(a)) {
                return;
            }
            let c = this.webviews.get(o) ?? null;
            let l = this.webviews.get(s) ?? null;
            let u = this.tabPersistenceStates.get(o) ?? null;
            let d = this.tabPersistenceStates.get(s) ?? null;
            let dispatchFn = this.snapshots.get(o) ?? null;
            if (l != null || this.pendingElectronTransfers.has(s) || this.snapshots.has(s) || d != null && d.mode !== `ephemeral`) {
                this.transferredWebviewKeys.add(a);
                if (c != null) {
                    this.disposeWebviewHost(e, t, o, `closed`);
                }
                this.removeTab(e, t);
                messageRouterInstance.dispatchMessage(`browser-sidebar-command`, {
                    ...u == null || u.mode === `ephemeral` ? {} : {
                        pagePersistence: {
                            browserStorageId: u.browserStorageId,
                            restore: u.mode === `restore-expected` ? `required` : `none`
                        }
                    },
                    browserTabId: t,
                    conversationId: e,
                    command: {
                        type: `close-tab`
                    }
                });
                if (i?.removeSourceBrowserStateWhenEmpty) {
                    this.removeConversationBrowserStateIfEmpty(e);
                }
                return;
            }
            if (c != null) {
                this.pagePresentationTransition.transferRoute(c);
            }
            this.pendingElectronTransfers.delete(o);
            this.pendingElectronTransfers.delete(s);
            this.transferredWebviewKeys.add(a);
            if (c != null) {
                this.webviews.delete(o);
                c.transfer({
                    browserTabId: r,
                    conversationId: n,
                    elementKey: getCompositeWebviewStorageKey(n, r),
                    partition: buildCacheKey(n, r)
                });
                this.webviews.set(s, c);
            }
            let p = this.browserUseViewportSizes.get(o) ?? null;
            let m = this.browserUseTabKeys.has(o);
            let h = this.tabCaptureActiveKeys.delete(o);
            let g = this.mountStates.get(o) ?? null;
            let _ = this.browserUseActiveTabKeys.delete(o);
            this.browserUseCaptureSurfaceSizes.delete(o);
            this.browserUseCursorStates.delete(o);
            this.browserUseTabKeys.delete(o);
            this.browserUseViewportSizes.delete(o);
            this.mountStates.delete(o);
            this.tabPersistenceStates.delete(o);
            if (u != null) {
                this.tabPersistenceStates.set(s, u);
            }
            if (c != null) {
                this.registerWebviewHost(c, u == null || u.mode === `ephemeral` ? undefined : this.getPagePersistence(n, r));
            }
            this.pendingElectronTransfers.set(s, {
                sourceBrowserTabId: t,
                sourceConversationId: e
            });
            messageRouterInstance.dispatchMessage(`browser-sidebar-command`, {
                conversationId: e,
                browserTabId: t,
                command: {
                    type: `transfer-conversation`,
                    targetBrowserTabId: r,
                    targetConversationId: n
                }
            });
            let v = false;
            if (m) {
                this.browserUseTabKeys.add(s);
                this.syncBrowserUseTabKeys(e);
                v = true;
            }
            if (_) {
                this.browserUseActiveTabKeys.add(s);
            }
            if (p != null) {
                this.browserUseViewportSizes.set(s, p);
            }
            if (h && c != null) {
                this.tabCaptureActiveKeys.add(s);
            }
            if (g != null) {
                this.mountStates.set(s, {
                    claimKeys: new Set,
                    generation: g.generation
                });
            }
            c?.setBrowserUseCaptureSurfaceSize(null);
            logger__Kp_mubr.info(`IAB_LIFECYCLE renderer reassociated browser sidebar tab`, {
                safe: {
                    sourceBrowserTabId: t,
                    sourceConversationId: e,
                    targetBrowserTabId: r,
                    targetConversationId: n
                }
            });
            let y = this.deviceToolbarTabStates.get(o);
            if (dispatchFn != null) {
                this.snapshots.delete(o);
                this.snapshots.set(s, dispatchFn);
            }
            if (v) {
                this.syncBrowserUseTabKeys(n);
            }
            if (y != null) {
                this.deviceToolbarTabStates.delete(o);
                this.deviceToolbarTabStates.set(s, y);
            }
            if (i?.removeSourceBrowserStateWhenEmpty) {
                this.removeConversationBrowserStateIfEmpty(e);
            }
            this.emitMediaChange();
        }
        consumePendingElectronTransfer(e, t) {
            let n = createCompositeKey__fN_2fpbe(e, t);
            let r = this.pendingElectronTransfers.get(n) ?? null;
            if (r == null) {
                return null;
            }
            this.pendingElectronTransfers.delete(n);
            this.releaseDetachedPrewarmedEmptyWebview(e, t);
            return r;
        }
        peekPendingElectronTransfer(e, t) {
            return this.pendingElectronTransfers.get(createCompositeKey__fN_2fpbe(e, t)) ?? null;
        }
        disposeAll() {
            this.prewarmedEmptyWebview = null;
            this.pagePresentationTransition.disposeAll();
            this.snapshots.clear();
            this.ownerRoutePathsByConversation.clear();
            this.browserUseCursorStates.clear();
            this.browserUseActiveTabKeys.clear();
            this.browserUseTabKeys.clear();
            this.browserUseTabIdsKeysByConversation.clear();
            this.refreshBrowserUseTabs();
            this.browserUseCaptureSurfaceSizes.clear();
            this.browserUseViewportSizes.clear();
            this.tabCaptureActiveKeys.clear();
            this.deviceToolbarTabStates.clear();
            this.tabPersistenceStates.clear();
            this.pendingElectronTransfers.clear();
            this.mountStates.clear();
            for (let e of this.webviews.values()){
                e.dispose();
            }
            this.webviews.clear();
            this.transferredWebviewKeys.clear();
            this.emitMediaChange();
        }
        emitChange() {
            for (let e of this.listeners){
                e();
            }
        }
        emitMediaChange() {
            this.refreshMediaTabs();
            this.emitChange();
        }
        resyncAttachedWebviews() {
            for (let e of this.webviews.values()){
                e.resync();
            }
        }
        disposeWebviewHost(e, browserTabId, n, r) {
            let i = this.webviews.get(n) ?? null;
            this.webviews.delete(n);
            if (i != null) {
                if (this.prewarmedEmptyWebview === i) {
                    this.prewarmedEmptyWebview = null;
                }
                this.prewarmedEmptyWebviews.delete(i);
                if (r === `closed`) {
                    this.pagePresentationTransition.removeTab(i);
                } else {
                    this.pagePresentationTransition.disposeHost(i);
                }
                i.dispose();
                logger__Kp_mubr.info(`IAB_LIFECYCLE renderer removed browser sidebar webview`, {
                    safe: {
                        browserTabId,
                        conversationId: e,
                        tabType: r
                    }
                });
            }
        }
        releasePrewarmedEmptyWebview(e) {
            if (!this.prewarmedEmptyWebviews.has(e)) {
                return false;
            }
            if (this.prewarmedEmptyWebview === e) {
                this.prewarmedEmptyWebview = null;
            }
            let t = e.getConversationId();
            let n = e.getBrowserTabId();
            let r = createCompositeKey__fN_2fpbe(t, n);
            let i = this.snapshots.get(r);
            if (i?.tabType !== $l.NEW_TAB_PAGE || i.url.length > 0 || this.browserUseTabKeys.has(r) || this.tabCaptureActiveKeys.has(r) || this.pendingElectronTransfers.has(r) || normalizeUrlOrEmpty(getWebviewByKey(t, n) ?? ``).length > 0 || getPendingWebviewAdoptionLease(t, n) != null || getCacheEntry__aVr_2fhgg(t, n) != null) {
                return false;
            }
            this.disposeCurrentWebviewHost(e);
            this.emitChange();
            return true;
        }
        releaseDetachedPrewarmedEmptyWebview(e, t) {
            let n = createCompositeKey__fN_2fpbe(e, t);
            let r = this.webviews.get(n);
            if (!(r == null || !this.prewarmedEmptyWebviews.has(r) || (this.mountStates.get(n)?.claimKeys.size ?? 0) > 0)) {
                this.releasePrewarmedEmptyWebview(r);
            }
        }
        destroyWebviewAtHostRequest(e, t, mountGeneration, r, teardownId) {
            let a = createCompositeKey__fN_2fpbe(e, t);
            let o = this.webviews.get(a) ?? null;
            let s = o != null && o.shouldDestroyForHostRequest({
                mountGeneration,
                reason: r
            }) !== false;
            if (s) {
                this.disposeWebviewHost(e, t, a, r);
            }
            if (r === `closed`) {
                this.removeTab(e, t);
            } else if (s) {
                this.emitMediaChange();
            }
            messageRouterInstance.dispatchMessage(`browser-sidebar-webview-destroyed`, {
                browserTabId: t,
                conversationId: e,
                reason: r,
                teardownId
            });
        }
        getLastConversationBrowserTabId(e, t) {
            let n = `${e}\0`;
            let r = null;
            for (let conversationId__e_2g3y3 of t){
                if (conversationId__e_2g3y3.startsWith(n)) {
                    r = Jl(conversationId__e_2g3y3.slice(n.length));
                }
            }
            return r;
        }
        getConversationBrowserTabIdsFromKeys(e, t) {
            let n = `${e}\0`;
            let r = [];
            for (let e of t){
                if (e.startsWith(n)) {
                    r.push(Jl(e.slice(n.length)));
                }
            }
            return r;
        }
        removeConversationBrowserStateIfEmpty(e) {
            if (!(this.getConversationBrowserTabIds(e).length > 0)) {
                this.removeConversationTabs(e);
            }
        }
        syncBrowserUseTabKeys(e) {
            let fallbackHandler__t_2g47j = this.getConversationBrowserTabIdsFromKeys(e, this.browserUseTabKeys);
            if (fallbackHandler__t_2g47j.length === 0) {
                this.browserUseTabIdsKeysByConversation.delete(e);
                this.refreshBrowserUseTabs();
                return;
            }
            this.browserUseTabIdsKeysByConversation.set(e, fallbackHandler__t_2g47j.join(`\0`));
            this.refreshBrowserUseTabs();
        }
        refreshBrowserUseTabs() {
            this.browserUseTabs = Array.from(this.browserUseTabKeys, parseConversationBrowserTabKey);
        }
        refreshMediaTabs() {
            let e = [];
            for (let [t, n] of this.snapshots){
                if (!this.browserUseTabKeys.has(t) && !this.webviews.has(t) || n.tabType !== $l.WEB || !n.isAudible && !n.isCapturingUserMedia) {
                    continue;
                }
                let r = parseConversationBrowserTabKey(t);
                e.push({
                    ...r,
                    faviconUrl: n.faviconUrl,
                    isAudioMuted: n.isAudioMuted,
                    isAudible: n.isAudible,
                    isCapturingCamera: n.isCapturingCamera,
                    isCapturingMicrophone: n.isCapturingMicrophone,
                    isCapturingUserMedia: n.isCapturingUserMedia,
                    isLoading: n.isLoading,
                    isWaitingForResponse: n.isWaitingForResponse === true,
                    ownerRoutePath: this.ownerRoutePathsByConversation.get(r.conversationId) ?? null,
                    title: n.title,
                    url: n.url
                });
            }
            if (!areWebviewTabsEqual(this.mediaTabs, e)) {
                this.mediaTabs = e;
            }
        }
        removeConversationTabs(e) {
            let t = `${e}\0`;
            this.pagePresentationTransition.removeConversation(e);
            for (let e of this.snapshots.keys()){
                if (e.startsWith(t)) {
                    this.snapshots.delete(e);
                }
            }
            for (let e of this.browserUseActiveTabKeys){
                if (e.startsWith(t)) {
                    this.browserUseActiveTabKeys.delete(e);
                }
            }
            for (let e of this.browserUseTabKeys){
                if (e.startsWith(t)) {
                    this.browserUseTabKeys.delete(e);
                }
            }
            this.refreshBrowserUseTabs();
            for (let e of this.browserUseCursorStates.keys()){
                if (e.startsWith(t)) {
                    this.browserUseCursorStates.delete(e);
                }
            }
            for (let e of this.browserUseCaptureSurfaceSizes.keys()){
                if (e.startsWith(t)) {
                    this.browserUseCaptureSurfaceSizes.delete(e);
                }
            }
            for (let e of this.browserUseViewportSizes.keys()){
                if (e.startsWith(t)) {
                    this.browserUseViewportSizes.delete(e);
                }
            }
            for (let e of this.tabCaptureActiveKeys){
                if (e.startsWith(t)) {
                    this.tabCaptureActiveKeys.delete(e);
                }
            }
            for (let e of this.deviceToolbarTabStates.keys()){
                if (e.startsWith(t)) {
                    this.deviceToolbarTabStates.delete(e);
                }
            }
            for (let e of this.pendingElectronTransfers.keys()){
                if (e.startsWith(t)) {
                    this.pendingElectronTransfers.delete(e);
                }
            }
            for (let e of this.mountStates.keys()){
                if (e.startsWith(t)) {
                    this.mountStates.delete(e);
                }
            }
            for (let e of this.tabPersistenceStates.keys()){
                if (e.startsWith(t)) {
                    this.tabPersistenceStates.delete(e);
                }
            }
            for (let [e, n] of this.webviews.entries()){
                if (e.startsWith(t)) {
                    this.webviews.delete(e);
                    this.pagePresentationTransition.disposeHost(n);
                    n.dispose();
                }
            }
            this.browserUseTabIdsKeysByConversation.delete(e);
            this.ownerRoutePathsByConversation.delete(e);
        }
        markWebviewAttached(e, t, n) {
            let r = this.getMountGeneration(e, t);
            if (r === n) {
                unregisterWebviewHandler(e, t);
            }
            this.pagePresentationTransition.acknowledgeAttachment(this.webviews.get(createCompositeKey__fN_2fpbe(e, t)) ?? null, n, r);
            this.emitChange();
        }
    };
}
