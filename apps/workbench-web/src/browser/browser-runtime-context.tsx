import { useIntl } from "@opencraft/i18n/react";
import type {
  BrowserPageId,
  BrowserPageSnapshot,
  BrowserTabId,
  BrowserTabSnapshot,
} from "@opencraft/browser-core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";

import { BrowserPresentationCoordinator } from "./browser-presentation-coordinator";
import { BrowserWorkbenchCoordinator } from "./browser-workbench-coordinator";
import { WebBrowserPageRuntime } from "./web-browser-runtime";
import type { BrowserSurfaceHost } from "./web-browser-surface-host";
import type { BrowserLocalMenuController } from './browser-local-menu';
import { createDeferredView } from '@opencraft/extension-react';

const BrowserLocalMenu = createDeferredView(async () => (await import('./browser-local-menu-view')).BrowserLocalMenu);

/** Keep labels and clipboard lifetime owned by the persistent host, not the
 * lazily mounted menu. Closing a menu must not cancel its pending copy intent. */
function BrowserLocalMenuHost({ controller }: { readonly controller: BrowserLocalMenuController }) {
  const intl = useIntl();
  const menu = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useLayoutEffect(() => { controller.setLabels({
    copy: intl.formatMessage({ id: 'browser.menu.copy', defaultMessage: 'Copy' }),
    copyLink: intl.formatMessage({ id: 'browser.menu.copyLink', defaultMessage: 'Copy link address' }),
  }); }, [intl, controller]);
  useLayoutEffect(() => () => controller.retire(), [controller]);
  return menu ? <BrowserLocalMenu controller={controller} /> : null;
}

interface BrowserRuntimeContextValue {
  readonly pages: WebBrowserPageRuntime;
  readonly surfaces: BrowserSurfaceHost;
  readonly presentations: BrowserPresentationCoordinator;
  readonly workbench: BrowserWorkbenchCoordinator;
}

const BrowserRuntimeContext = createContext<BrowserRuntimeContextValue | null>(null);
export function useOptionalBrowserRuntime() { return useContext(BrowserRuntimeContext); }

export function BrowserEnvironmentProvider({
  children,
  pages,
  surfaces,
  presentations,
  workbench,
}: {
  readonly children: ReactNode;
  readonly pages: WebBrowserPageRuntime;
  readonly surfaces: BrowserSurfaceHost;
  readonly presentations: BrowserPresentationCoordinator;
  readonly workbench: BrowserWorkbenchCoordinator;
}) {
  return (
    <BrowserRuntimeContext.Provider value={{ pages, surfaces, presentations, workbench }}>
      {children}
    </BrowserRuntimeContext.Provider>
  );
}

function useBrowserRuntimeContext(): BrowserRuntimeContextValue {
  const value = useContext(BrowserRuntimeContext);
  if (value === null) throw new Error("BrowserEnvironmentProvider is missing");
  return value;
}

export function useWebBrowserPageRuntime() {
  return useBrowserRuntimeContext().pages;
}

export function useBrowserPresentationCoordinator() {
  return useBrowserRuntimeContext().presentations;
}

export function useBrowserWorkbench() {
  return useBrowserRuntimeContext().workbench;
}

export function useWebBrowserPage(pageId: BrowserPageId): BrowserPageSnapshot | null {
  const pages = useWebBrowserPageRuntime();
  const subscribe = useCallback(
    (listener: () => void) => pages.has(pageId) ? pages.subscribe(pageId, listener) : () => undefined,
    [pages, pageId],
  );
  const getSnapshot = useCallback(() => pages.getSnapshot(pageId), [pages, pageId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useBrowserTab(tabId: BrowserTabId): BrowserTabSnapshot | null {
  const workbench = useBrowserWorkbench();
  const subscribe = useCallback(
    (listener: () => void) => workbench.subscribeTab(tabId, listener),
    [workbench, tabId],
  );
  const getSnapshot = useCallback(() => workbench.getTabSnapshot(tabId), [workbench, tabId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function BrowserPresentationRoot() {
  const intl = useIntl();
  const { surfaces } = useBrowserRuntimeContext();
  const rootRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    surfaces.setNewTabLabels?.({
      title: intl.formatMessage({ id: "panel.newBrowser", defaultMessage: "New browser tab" }),
      hint: intl.formatMessage({ id: "panel.addressHint", defaultMessage: "Enter an address above to navigate" }),
    });
  }, [intl, surfaces]);
  useLayoutEffect(() => {
    surfaces.setRoot(rootRef.current);
    return () => surfaces.setRoot(null);
  }, [surfaces]);
  return <><div ref={rootRef} className="web-browser-presentation-root" />
    {surfaces.localMenu && <BrowserLocalMenuHost controller={surfaces.localMenu} />}</>;
}
