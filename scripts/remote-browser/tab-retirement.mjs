import { randomUUID } from 'node:crypto';
import { sessionLink } from '../remote-browser-state-file.mjs';
import { recordRetirementFacts } from './retirement-facts.mjs';

function parse(value, fallback) {
  try { const result = JSON.parse(value ?? JSON.stringify(fallback));
    return Array.isArray(fallback) ? Array.isArray(result) ? result : fallback
      : result && typeof result === 'object' && !Array.isArray(result) ? result : fallback;
  } catch { return fallback; }
}

function retireMetadata(draft, page, threadId, advanceRevision) {
  const state = draft.states.find(([owner]) => owner === page.ownerId)?.[1];
  const lease = JSON.parse(page.key)[1], record = draft.pages.find(p => p.key === page.key);
  const link = sessionLink(state, lease) ?? record?.link;
  const storage = parse(state?.values.storage, {});
  const pageIds = Object.entries(storage).filter(([, value]) => typeof value === 'string' && value.replace(':', '-') === lease).map(([id]) => id);
  // Legacy clients may have committed storage removal before page/tab removal.
  // An identity explicitly reassigned to another lease is outside this close.
  if (typeof link?.pageId === 'string' && !Object.hasOwn(storage, link.pageId)) pageIds.push(link.pageId);
  const tabs = parse(state?.values.tabs, []), tabIds = tabs.filter(tab => pageIds.includes(tab?.pageId) && typeof tab?.id === 'string').map(tab => tab.id);
  const retiredTabIds = [...new Set([...tabIds, ...(typeof link?.tabId === 'string' && !tabs.some(tab => tab?.id === link.tabId) ? [link.tabId] : [])])];
  recordRetirementFacts(draft, { key: page.key, ownerId: page.ownerId, lease, pageIds, tabIds: retiredTabIds });
  if (link && ['pageId', 'tabId', 'scopeId'].every(key => typeof link[key] === 'string')) {
    const bindings = parse(state?.values.bindings, []);
    let conversation = threadId ?? bindings.find(b => b?.scopeId === link.scopeId && b.hostId === link.hostId)?.threadId;
    if (!conversation && link.scopeId?.startsWith('conversation:')) {
      try { const [host, thread] = JSON.parse(link.scopeId.slice('conversation:'.length)); if (host === link.hostId) conversation = thread; } catch {}
    }
    draft.closedTabs ??= [];
    if (!draft.closedTabs.some(receipt => receipt.key === page.key)) draft.closedTabs.push({
      key: page.key, ownerId: page.ownerId, lease, ...link, threadId: typeof conversation === 'string' ? conversation : null,
      pageIds: [...new Set(pageIds)], tabIds: retiredTabIds, status: 'closing',
    });
  }
  let presentationChanged = false;
  if (state?.presentationRequests) state.presentationRequests = state.presentationRequests.map(request => {
    if (!retiredTabIds.includes(request.tabId) || !['pending', 'claimed'].includes(request.status)) return request;
    const receipt = draft.presentationReceipts.get(request.id);
    if (!receipt || !['pending', 'claimed'].includes(receipt.status)) return request;
    const cancelled = { ...receipt, status: 'cancelled' };
    draft.presentationReceipts.put(cancelled); presentationChanged = true; return cancelled;
  });
  if (!state || !pageIds.length) {
    if (presentationChanged && advanceRevision) state.revision++;
    return presentationChanged;
  }
  const values = { ...state.values }, keyRevisions = { ...state.keyRevisions };
  const nextStorage = Object.fromEntries(Object.entries(storage).filter(([id]) => !pageIds.includes(id)));
  const changes = { storage: nextStorage, pages: parse(state.values.pages, []).filter(row => !pageIds.includes(row?.id)), tabs: tabs.filter(row => !pageIds.includes(row?.pageId)) };
  let changed = false;
  for (const [key, value] of Object.entries(changes)) {
    const encoded = JSON.stringify(value);
    if (values[key] !== encoded) { changed = true; values[key] = encoded; keyRevisions[key] = (keyRevisions[key] ?? 0) + 1; }
  }
  if (changed) {
    const next = { ...state, values, keyRevisions, revision: state.revision + (advanceRevision ? 1 : 0) };
    draft.states = draft.states.filter(([owner]) => owner !== page.ownerId); draft.states.push([page.ownerId, next]);
  }
  if (!changed && presentationChanged && advanceRevision) state.revision++;
  return changed || presentationChanged;
}

/** Synchronous part shared by API close and legacy metadata removal. The latter
 * is already one account revision and must include all close dependencies. */
export function commitRemoteRetirement(draft, page, { threadId, advanceRevision = true } = {}) {
  if (!draft.retired.includes(page.key)) draft.retired.push(page.key);
  const changed = retireMetadata(draft, page, threadId, advanceRevision);
  const record = draft.pages.find(p => p.key === page.key);
  const nativeAbsent = record?.closeNativeAbsent ?? (record?.runtime?.kind === 'absent' && !page.live);
  if (record) {
    record.closeNativeAbsent = nativeAbsent; record.lifecycle = 'closing'; record.closing = true;
    record.runtime = { ...record.runtime, kind: 'stopping', closeOperationId: record.runtime?.closeOperationId ?? randomUUID() };
  }
  return { changed, nativeAbsent };
}

/** Every close source shares durable intent and a native retirement barrier.
 * Caller admission runs inside the commit. Once committed, cleanup belongs to
 * the tab owner and survives caller cancellation, revocation and disconnect. */
export function retireRemotePage(service, page, replying, { admit = () => {}, threadId } = {}) {
  if (page.retirement) return page.retirement;
  let accepted = service.store.account(page.ownerId).pages.find(p => p.key === page.key)?.lifecycle === 'closing';
  let admitted, rejected;
  page.retirementIntent = new Promise((resolve, reject) => { admitted = resolve; rejected = reject; });
  void page.retirementIntent.catch(() => {});
  page.retirement = (async () => {
    const intent = await service.commit(draft => {
      admit();
      return commitRemoteRetirement(draft, page, { threadId });
    }, { ownerId: page.ownerId, keys: [page.key] });
    accepted = true; page.closing = true;
    for (const [owner, state] of service.store.account(page.ownerId).states) service.states.set(owner, state);
    service.resetVisibility(page);
    clearTimeout(page.keyTimer); clearTimeout(page.slowKeyTimer); clearTimeout(page.retirementTimer);
    page.keyTimer = page.slowKeyTimer = page.retirementTimer = null;
    page.controller = null; page.controlToken = null; page.controlKind = null; page.controlEpoch = (page.controlEpoch ?? 0) + 1;
    admitted();
    for (const request of service.requests.values()) if (request.page === page.id && request.method === 'automation') request.cancel?.();
    for (const [ws, viewer] of service.viewers(page)) { viewer.abort?.abort(); if (ws !== replying) ws.close(1000, 'Browser tab closed'); }
    if (intent.changed) service.metadataChanged(page.ownerId);
    if (page.creating) await page.creating.catch(() => {});
    if (!intent.nativeAbsent) {
      await service.start();
      // Unknown creation/close retains its reservation until this positive ACK.
      await service.request(page.id, 'close');
    }
    // Publish completion and free capacity together, before dropping memory.
    await service.commit(draft => {
      draft.pages = draft.pages.filter(p => p.key !== page.key);
      const receipt = draft.closedTabs?.find(r => r.key === page.key);
      if (receipt) { receipt.status = 'closed'; receipt.closedAt = Date.now(); }
      const completed = draft.closedTabs?.filter(r => r.ownerId === page.ownerId && r.status === 'closed') ?? [];
      const retained = new Set(); let bytes = 0;
      for (const entry of completed.slice(-256).reverse()) {
        bytes += Buffer.byteLength(JSON.stringify(entry)); if (bytes > 512 * 1024) break;
        retained.add(entry.key);
      }
      if (draft.closedTabs) draft.closedTabs = draft.closedTabs.filter(r => r.ownerId !== page.ownerId || r.status !== 'closed' || retained.has(r.key));
    }, { ownerId: page.ownerId });
    page.live = false;
    if (service.pages.get(page.key) === page) service.pages.delete(page.key);
    service.viewers(page).clear();
    if (service.ownerConnector && service.child?.runtimeCurrent === false && !service.pages.size && !service.requests.size && !service.attachments.size) {
      const child = service.child; service.child = null; service.starting = null; child.kill();
    }
  })().catch(error => {
    rejected(error);
    page.retirement = null;
    // A reported failure can follow intent publication. That known
    // committed intent still owns cleanup.
    accepted ||= service.store.account(page.ownerId).pages.find(p => p.key === page.key)?.lifecycle === 'closing';
    if (accepted) {
      if (!page.closing) {
        page.closing = true; service.resetVisibility(page);
        for (const [owner, state] of service.store.account(page.ownerId).states) service.states.set(owner, state); service.metadataChanged(page.ownerId);
      }
      service.retryRetirement(page); Object.assign(error, { retryable: false, outcome: 'unknown' });
    }
    throw error;
  });
  return page.retirement;
}
