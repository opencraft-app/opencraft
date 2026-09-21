import { createImplementation as managerImplementation } from "./codex/browser-manager.js";
import { createImplementation as transitionImplementation } from "./codex/presentation-transition.js";
import { DEFAULT_WEBVIEW_STATE, RESPONSIVE_PRESET_ID, initializeBrowserViewportPresets,
  getDefaultPanelWidth, clampPanelWidth__rBr_2f54e } from "./codex/viewport-presets.js";

type Value = Record<string, any>;
const logger = { info() {} };
export function createCodexBrowserManager(Host: new (options: Value) => any) {
  initializeBrowserViewportPresets();
  const removals: Array<() => void> = [];
  const eventScope = (target: Window | Document) => ({
    get visibilityState() { return document.visibilityState; },
    addEventListener(type: string, callback: EventListener) {
      target.addEventListener(type, callback);
      removals.push(() => target.removeEventListener(type, callback));
    },
  });
  const listeners = new Map<string, Set<(value: any) => void>>();
  const router = {
    subscribe(type: string, listener: (value: any) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener); listeners.set(type, set);
      return () => set.delete(listener);
    },
    dispatchMessage(type: string, value: any) {
      for (const listener of listeners.get(type) ?? []) listener(value);
    },
  };
  const Transition = transitionImplementation({ logger__Kp_mubr: logger });
  const key = (owner: string, tab: string) => `${owner}\0${tab}`;
  let manager: any;
  const Manager = managerImplementation({
    window: eventScope(window), document: eventScope(document),
    PagePresentationTransition: Transition, WebviewSidebarManager: Host,
    messageRouterInstance: router, logger__Kp_mubr: logger,
    createCompositeKey__fN_2fpbe: key,
    identityPassthrough: (value: unknown) => value,
    Jl: (value: string) => value,
    joinKeyWithNull: key, buildCacheKey: key, getCompositeWebviewStorageKey: key,
    parseConversationBrowserTabKey: (value: string) => {
      const [conversationId, browserTabId] = value.split("\0");
      return { conversationId, browserTabId };
    },
    normalizeUrlOrEmpty: (value: string) => value.trim(),
    $l: { WEB: "web", NEW_TAB_PAGE: "new-tab-page" },
    DEFAULT_WEBVIEW_STATE, RESPONSIVE_PRESET_ID,
    areWebviewTabsEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
    getDefaultPanelWidth, clampPanelWidth__rBr_2f54e,
    // Standard guests have no Owl adoption registry. Absence is explicit.
    getCacheEntry__aVr_2fhgg: () => null, getPendingWebviewAdoptionLease: () => null,
    getWebviewByKey: (owner: string, tab: string) => manager.getSnapshot(owner, tab)?.url ?? "",
    unregisterWebviewHandler: () => {},
    ym: { browserSidebar: {
      registerWebviewHostSession: async () => true,
      registerWebviewHost: async (identity: Value) => {
        const host = manager.webviews.get(key(identity.conversationId, identity.browserTabId));
        if (!host || host.getHostGeneration() !== identity.hostGeneration) return false;
        await host.whenReady();
        return manager.webviews.get(key(identity.conversationId, identity.browserTabId)) === host;
      },
    } },
  });
  manager = new Manager();
  const disposeSource = manager.disposeAll.bind(manager);
  manager.disposeAll = () => {
    // Source manager has renderer-wide lifetime; our app supervisor can be
    // disposed independently of the renderer, so release its event ports too.
    for (const remove of removals.splice(0)) remove();
    listeners.clear();
    disposeSource();
  };
  return manager;
}
