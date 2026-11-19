import { lazy, Suspense } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { BrowserTabId } from '@opencraft/browser-core';
import type { PanelToolbarActionContext } from '@opencraft/workbench-panels';
import type { PanelRendererProps } from '@opencraft/workbench-panels-react';
import type { BrowserWorkbenchCoordinator } from './browser-workbench-coordinator';

const BrowserPanelView = lazy(() => import('./browser-panel'));
function BrowserPanel(props: PanelRendererProps) {
  return <Suspense fallback={null}><BrowserPanelView {...props} /></Suspense>;
}

export function createBrowserWorkbenchPanelPlugin(
  workbench: BrowserWorkbenchCoordinator,
  onCreateTab: (context: PanelToolbarActionContext) => void = () => undefined,
) {
  const browserPanelTab = (browserTabId: string) => {
    const tabId = browserTabId as BrowserTabId;
    const page = workbench.pageForTab(tabId);
    return {
      id: `browser:${tabId}`,
      kind: "browser",
      region: "right" as const,
      title: page?.title ?? "Browser",
      icon: "browser",
      showTabIcon: true,
      resource: tabId,
      closable: true,
      preview: false,
      durableRoute: {
        kind: "browser-tab",
        params: { browserTabId: tabId },
        payloadVersion: 1,
      },
    };
  };
  return Object.assign(function BrowserWorkbenchPanelPlugin(ctx: Context) {
    const remove = [
      ctx.workbenchPanels.register<{ readonly browserTabId: string }>({
        kind: "browser",
        tabDirectory: {
          read: ownerId => workbench.listPanelTabs(ownerId).map(({ tab }) => browserPanelTab(tab.id)),
          subscribe: (ownerId, changed) => workbench.subscribePanelTabs(ownerId, changed),
        },
        restoreTabs: (ownerId) => workbench.listPanelTabs(ownerId)
          .map(({ tab }) => browserPanelTab(tab.id)),
        createTab: ({ browserTabId }) => browserPanelTab(browserTabId),
        disposeTab: (tab, ownerId, reason) => {
          if (tab.resource !== undefined)
            workbench.releasePanel(ownerId, tab.resource as BrowserTabId, reason === "close");
        },
      }),
      ctx.workbenchPanelRenderers.register({ kind: "browser", Component: BrowserPanel, presentationReadiness: "renderer", subscribePreview: (tab, listener) => workbench.onPresentationChanged(tab.resource as BrowserTabId, listener), preview: async (tab, _owner, signal) => {
        if (!tab.resource || signal.aborted) return null;
        const presentation = await workbench.readPresentation(tab.resource as BrowserTabId);
        if (signal.aborted) return null;
        if (presentation) return presentation.thumbnail ? { kind: "image", src: presentation.thumbnail, iconSrc: presentation.favicon ?? undefined } : { kind: "placeholder", iconSrc: presentation.favicon ?? undefined };
        const src = await workbench.capturePreview(tab.resource as BrowserTabId);
        return src && !signal.aborted ? { kind: "image", src } : null;
      } }),
      ctx.workbenchPanels.registerToolbarAction({
        id: "opencraft.browser.new-tab",
        region: "right",
        order: 100,
        label: "New browser tab",
        creationLabel: "Browser",
        icon: "browser",
        run: onCreateTab,
      }),
    ];
    ctx.effect(() => () => remove.reverse().forEach((dispose) => dispose()));
  }, { inject: ["workbenchPanels", "workbenchPanelRenderers"] });
}
