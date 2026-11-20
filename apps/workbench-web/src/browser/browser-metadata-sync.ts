import type { BrowserMetadataStorage, BrowserPresentationReason } from './desktop-browser-storage';
import type { WebBrowserPageRuntime } from './web-browser-runtime';
import type { BrowserWorkbenchCoordinator } from './browser-workbench-coordinator';

/** Import committed additions and retire authoritative identities. Surviving
 * pages keep their native surface, focus and pending navigation. */
export function subscribeBrowserMetadata(storage: BrowserMetadataStorage,
  bindings: { restore(): void }, surfaces: { restoreStorage(): void },
  pages: WebBrowserPageRuntime, workbench: BrowserWorkbenchCoordinator) {
  let disposed = false;
  const lifetime = new AbortController();
  const processing = new Set<string>(), shown = new Set<string>();
  const observed = new Map<string, Set<BrowserPresentationReason>>();
  const observe = (id: string, reason: BrowserPresentationReason) => {
    const reasons = observed.get(id) ?? new Set<BrowserPresentationReason>();
    if (reasons.has(reason)) return;
    reasons.add(reason); observed.set(id, reasons);
    void storage.acknowledgePresentation!(id, 'observe', reason).catch(() => {});
  };
  const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
  const presentations = () => {
    if (disposed || !storage.acknowledgePresentation) return;
    const requests = storage.presentationRequests?.() ?? [];
    const retained = new Set(requests.map(request => request.id));
    for (const id of shown) if (!retained.has(id)) shown.delete(id);
    for (const id of observed.keys()) if (!retained.has(id)) observed.delete(id);
    for (const request of requests) {
      if (!['pending', 'claimed'].includes(request.status) || request.expiresAt <= Date.now() || processing.has(request.id)
        || request.clientId && request.clientId !== storage.presentationClientId) continue;
      const blocked = !visible() ? 'hidden' : workbench.presentationBlockReason(request);
      if (blocked) { observe(request.id, blocked); continue; }
      processing.add(request.id);
      void (async () => {
        const claim = await storage.acknowledgePresentation!(request.id, 'claim');
        if (claim.status !== 'claimed') return;
        if (disposed || !visible() || claim.expiresAt <= Date.now() || !workbench.canPresentConversationTab(request)) {
          await storage.acknowledgePresentation!(request.id, 'failed', !visible() ? 'hidden' : workbench.presentationBlockReason(request) ?? 'view-inactive'); return;
        }
        if (!shown.has(request.id)) {
          // Mark before touching presentation: a lost ACK cannot replay focus.
          shown.add(request.id);
          if (!workbench.presentConversationTab(request)) {
            await storage.acknowledgePresentation!(request.id, 'failed', 'panel-unavailable'); return;
          }
        }
        // A lost ACK may retry observation, never focus. Recheck the physical
        // panel: a previously painted surface can have left the viewport.
        const painted = await workbench.waitForConversationPresentation(request, lifetime.signal, claim.expiresAt);
        if (!disposed) await storage.acknowledgePresentation!(request.id,
          painted && visible() && claim.expiresAt > Date.now() && workbench.isConversationTabPresented(request) ? 'visible' : 'failed',
          !painted ? 'paint-timeout' : !visible() ? 'hidden' : undefined);
      })().catch(() => { /* Reconnect reloads receipts; shown IDs never replay focus. */ })
        .finally(() => processing.delete(request.id));
    }
  };
  const unsubscribe = storage.subscribe?.(() => {
    for (const retirement of storage.retiredResources?.() ?? []) {
      workbench.retirePersisted(retirement.pageIds, retirement.tabIds);
      for (const pageId of retirement.pageIds) pages.retire(pageId as Parameters<WebBrowserPageRuntime['retire']>[0]);
    }
    bindings.restore(); surfaces.restoreStorage(); pages.restore();
    workbench.restoreTabs(); workbench.restorePersistedTabs(); presentations();
  }) ?? (() => {});
  const readiness = workbench.subscribePresentationReadiness(presentations);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', presentations);
  presentations();
  return () => {
    disposed = true; lifetime.abort(); unsubscribe(); readiness();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', presentations);
  };
}
