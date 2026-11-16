import type { BrowserMetadataStorage } from './desktop-browser-storage';
import type { WebBrowserPageRuntime } from './web-browser-runtime';
import type { BrowserWorkbenchCoordinator } from './browser-workbench-coordinator';

/** Import committed additions and retire authoritative identities. Surviving
 * pages keep their native surface, focus and pending navigation. */
export function subscribeBrowserMetadata(storage: BrowserMetadataStorage,
  bindings: { restore(): void }, surfaces: { restoreStorage(): void },
  pages: WebBrowserPageRuntime, workbench: BrowserWorkbenchCoordinator) {
  return storage.subscribe?.(() => {
    for (const retirement of storage.retiredResources?.() ?? []) {
      workbench.retirePersisted(retirement.pageIds, retirement.tabIds);
      for (const pageId of retirement.pageIds) pages.retire(pageId as Parameters<WebBrowserPageRuntime['retire']>[0]);
    }
    bindings.restore(); surfaces.restoreStorage(); pages.restore();
    workbench.restoreTabs(); workbench.restorePersistedTabs();
  }) ?? (() => {});
}
