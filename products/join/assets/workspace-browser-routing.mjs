import { sessionLink, browserConversation } from '../../../scripts/remote-browser-state-file.mjs';

/** Server-only mapping from central durable browser metadata to an admitted
 * conversation's exact browser port. resolveConversation must apply product
 * authorization and the ordinary runtime journal; no renderer supplies it.
 * Closing pages use their committed close receipt, never stale client metadata.
 * Accepted cleanup may require retained resource custody; this mapping does not
 * weaken the supplied resolver's authorization to make cleanup succeed. */
export function createWorkspaceBrowserRouting({ service, resolveConversation }) {
  if (typeof resolveConversation !== 'function') throw Error('Browser conversation resolver required');
  const routes = new Map();
  const denied = () => Error('Browser workspace route unavailable');
  const describe = pageId => {
    if (service.closed || !service.loaded) throw denied();
    const record = service.store.current.pages.find(page => page.id === pageId);
    if (!record || !['open','closing'].includes(record.lifecycle)) throw denied();
    const account = service.store.account(record.ownerId);
    let lease;
    try {
      const pair = JSON.parse(record.key);
      if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== record.ownerId || typeof pair[1] !== 'string') throw denied();
      lease = pair[1];
    } catch { throw denied(); }
    let hostId, threadId;
    if (record.lifecycle === 'closing') {
      const receipt = account.closedTabs?.find(item => item.key === record.key && item.status === 'closing');
      if (!receipt || receipt.ownerId !== record.ownerId || receipt.lease !== lease
        || receipt.tabId !== record.link?.tabId || receipt.pageId !== record.link?.pageId) throw denied();
      ({ hostId, threadId } = receipt);
      if (threadId === null) {
        if (typeof receipt.scopeId !== 'string' || receipt.scopeId.startsWith('conversation:')) throw denied();
        hostId ??= 'local-codex';
      }
    } else {
      const state = account.states.find(([owner]) => owner === record.ownerId)?.[1];
      const link = sessionLink(state, lease), conversation = browserConversation(state, link);
      if (!link || (conversation && link.hostId !== conversation.hostId)
        || link.pageId !== record.link?.pageId || link.tabId !== record.link?.tabId
        || link.scopeId !== record.link?.scopeId || link.hostId !== record.link?.hostId) throw denied();
      if (conversation) ({ hostId, threadId } = conversation);
      else {
        // A committed unbound draft is local until its conversation binding is
        // published. Missing/malformed links never select this branch.
        if (link.scopeId.startsWith('conversation:')) throw denied();
        let bindings; try { bindings = JSON.parse(state?.values.bindings ?? '[]'); } catch { throw denied(); }
        if (!Array.isArray(bindings) || bindings.some(binding => binding?.scopeId === link.scopeId)) throw denied();
        hostId = link.hostId ?? 'local-codex'; threadId = null;
      }
    }
    if (![record.ownerId, hostId].every(value => typeof value === 'string' && value.length > 0)
      || (threadId !== null && (typeof threadId !== 'string' || !threadId))) throw denied();
    return Object.freeze({ ownerId: record.ownerId, hostId, threadId, key: record.key,
      lifecycle: record.lifecycle, nativeGeneration: record.runtime?.generation ?? null });
  };
  const same = (left,right) => JSON.stringify(left) === JSON.stringify(right);
  return {
    async resolve(pageId) {
      await service.load(); await service.store.tail;
      const descriptor = describe(pageId);
      const resolved = await resolveConversation(descriptor);
      const lease = resolved?.lease ?? resolved;
      const assertAccess = resolved?.lease ? resolved.assertCurrent : () => {};
      if (typeof assertAccess !== 'function') throw denied();
      assertAccess();
      if (!lease || typeof lease.assertCurrent !== 'function' || typeof lease.connect !== 'function') throw denied();
      lease.assertCurrent();
      if (!same(descriptor,describe(pageId))) throw denied();
      if (!routes.has(pageId) && routes.size >= 1024) {
        // Bound live routes, not all pages ever visited. Captured request guards
        // retain their original descriptor and still fail after retirement.
        for (const [id, route] of routes) {
          try {
            if (!same(route.descriptor, describe(id))) routes.delete(id);
          } catch {
            routes.delete(id);
          }
        }
        if (routes.size >= 1024) throw denied();
      }
      routes.set(pageId,{descriptor,lease,assertAccess});return lease;
    },
    captureRoute(pageId,lease) {
      const route = routes.get(pageId);
      if (!route || route.lease !== lease) throw denied();
      const descriptor = route.descriptor;
      const check = () => {
        if (!same(descriptor,describe(pageId))) throw denied();
        route.assertAccess();
        lease.assertCurrent();
      };
      check(); return check;
    },
  };
}
