import { createImplementation as managerImplementation } from "./opencraft/browser-manager.js";
import { createImplementation as transitionImplementation } from "./opencraft/presentation-transition.js";
import { DEFAULT_WEBVIEW_STATE, RESPONSIVE_PRESET_ID, initializeBrowserViewportPresets } from "./opencraft/viewport-presets.js";

type Value = Record<string, any>;
const logger = { info() {} };
export function createOpenCraftBrowserManager(Host: new (options: Value) => any) {
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
  const Transition = transitionImplementation({});
  const key = (owner: string, tab: string) => `${owner}\0${tab}`;
  let manager: any;
  const Manager = managerImplementation({
    window: eventScope(window), document: eventScope(document),
    PagePresentationTransition: Transition, WebviewSidebarManager: Host,
    messageRouterInstance: router, logger,
    createCompositeKey: key, getCompositeWebviewStorageKey: key,
    parseConversationBrowserTabKey: (value: string) => {
      const [conversationId, browserTabId] = value.split("\0");
      return { conversationId, browserTabId };
    },
    webviewTabKinds: { WEB: "web", NEW_TAB_PAGE: "new-tab-page" },
    DEFAULT_WEBVIEW_STATE, RESPONSIVE_PRESET_ID,
    areWebviewTabsEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
    unregisterWebviewHandler: () => {},
    hostBridge: { browserSidebar: {
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
  const disposeManager = manager.disposeAll.bind(manager);
  manager.disposeAll = () => {
    // The manager has renderer-wide lifetime; the app supervisor can be
    // disposed independently of the renderer, so release its event ports too.
    for (const remove of removals.splice(0)) remove();
    listeners.clear();
    disposeManager();
  };
  return manager;
}
