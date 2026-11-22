import { createHash } from 'node:crypto';
import { browserMetadataValueLimit } from '@opencraft/browser-core/metadata-limits';
import { sessionError, conversationScopes, sessionLink, occupied } from '../remote-browser-state-file.mjs';

const fail = (code, message) => Object.assign(sessionError(code, message), { outcome: 'not-dispatched' });
function parse(state, key, fallback) {
  try { const value = JSON.parse(state.values[key] ?? JSON.stringify(fallback));
    if (Array.isArray(fallback) ? !Array.isArray(value) : !value || typeof value !== 'object' || Array.isArray(value)) throw 0;
    return value;
  } catch { throw fail('STATE_CONFLICT', 'Browser metadata must be synchronized before creating a tab'); }
}

/** A trusted invocation owns identity; one durable transaction publishes every
 * logical dependency. Native activation follows outside the state writer. */
export async function createRemoteTab(service, binding, input, { signal, requirePresentation = false } = {}) {
  if (!binding || typeof binding.authorize !== 'function' || ['ownerId', 'hostId', 'threadId', 'turnId', 'callId'].some(k => typeof binding[k] !== 'string' || !binding[k] || binding[k].length > 1024))
    throw fail('TAB_ACCESS_DENIED', 'Browser creation requires admitted execution identity');
  let url; try { url = new URL(input?.url); } catch {}
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192)
    throw fail('INVALID_ARGUMENT', 'Browser creation requires an absolute http(s) URL without credentials');
  const authorize = () => { signal?.throwIfAborted(); binding.authorize(); service.conversationLifecycle?.assertActive(binding.hostId,binding.threadId); if (service.closed) throw fail('BROWSER_UNAVAILABLE', 'Browser service closed'); };
  authorize(); await service.load(); authorize();
  await service.start(); authorize();
  if (service.ownerConnector && service.child?.automationCancellation !== 1)
    throw fail('BROWSER_OWNER_INCOMPATIBLE', 'Retained browser owner must support service automation before creating tabs');
  const identity = createHash('sha256').update(JSON.stringify([binding.ownerId, binding.hostId, binding.threadId, binding.turnId, binding.callId])).digest('hex');
  const lease = 'browser-' + identity, key = JSON.stringify([binding.ownerId, lease]);
  const release = await service.acquirePageActivation(key);
  let committed, prepared;
  try {
    committed = await service.commit(draft => {
      authorize();
      if (draft.retired.includes(key)) throw fail('SESSION_CLOSED', 'This creation already belongs to a closed tab');
      const previous = draft.pages.find(p => p.key === key);
      if (previous) {
        if (previous.creationUrl !== url.href) throw fail('OPERATION_CONFLICT', 'Browser creation identity reused with a different URL');
        const state = draft.states.find(([owner]) => owner === binding.ownerId)?.[1], link = sessionLink(state, lease);
        if (!link || link.hostId !== binding.hostId || !conversationScopes(state, binding.hostId, binding.threadId).has(link.scopeId))
          throw fail('TAB_ACCESS_DENIED', 'Browser creation no longer belongs to the admitted conversation');
        return prepared = { record: structuredClone(previous), changed: false };
      }
      if (requirePresentation && !service.presentationAvailable(binding.ownerId))
        throw fail('PRESENTATION_UNAVAILABLE', 'No connected workbench can present this browser tab');
      const used = draft.pages.filter(occupied);
      if (used.filter(p => p.ownerId === binding.ownerId).length >= 16) throw fail('ACCOUNT_CAPACITY', 'Your active browser page limit (16) is reached');
      if (draft.capacityUsed >= 64) throw fail('RUNTIME_CAPACITY', 'Shared browser capacity (64) is full');
      if (draft.pages.filter(p => p.ownerId === binding.ownerId).length >= 256) throw fail('SESSION_CAPACITY', 'Your saved browser session limit (256) is reached');
      const state = draft.states.find(([owner]) => owner === binding.ownerId)?.[1] ?? { revision: 0, values: {} };
      const pages = parse(state, 'pages', []), tabs = parse(state, 'tabs', []), storage = parse(state, 'storage', {}), bindings = parse(state, 'bindings', []);
      // Prefer the existing persisted conversation alias so open clients keep
      // the same resource list. A canonical alias supplies cold-start identity.
      const scopeId = bindings.find(b => b?.hostId === binding.hostId && b.threadId === binding.threadId && typeof b.scopeId === 'string')?.scopeId
        ?? 'conversation:' + JSON.stringify([binding.hostId, binding.threadId]);
      const pageId = 'page-' + identity, tabId = 'tab-' + identity, createdAt = Date.now();
      if (pages.some(p => p?.id === pageId) || tabs.some(t => t?.id === tabId) || Object.hasOwn(storage, pageId)) throw fail('STATE_CONFLICT', 'Browser tab identity already exists');
      pages.push({ id: pageId, ownerId: scopeId, hostId: binding.hostId, createdAt, entries: [{ url: url.href, title: url.hostname }], index: 0 });
      tabs.push({ id: tabId, pageId, ownerId: scopeId, createdAt, viewportMode: { type: 'responsive' } });
      storage[pageId] = lease;
      if (!bindings.some(b => b?.scopeId === scopeId)) bindings.push({ scopeId, hostId: binding.hostId, threadId: binding.threadId });
      if (!conversationScopes({ values: { bindings: JSON.stringify(bindings) } }, binding.hostId, binding.threadId).has(scopeId)) throw fail('TAB_ACCESS_DENIED', 'Browser scope is outside the admitted conversation');
      const values = { ...state.values }, keyRevisions = { ...state.keyRevisions };
      for (const [field, value] of Object.entries({ pages, tabs, storage, bindings })) {
        const encoded = JSON.stringify(value);
        if (encoded.length > browserMetadataValueLimit(field)) throw fail('STATE_TOO_LARGE', 'Browser metadata is too large');
        if (values[field] !== encoded) { values[field] = encoded; keyRevisions[field] = (keyRevisions[field] ?? 0) + 1; }
      }
      const next = { ...state, revision: state.revision + 1, values, keyRevisions };
      draft.states = draft.states.filter(([owner]) => owner !== binding.ownerId); draft.states.push([binding.ownerId, next]);
      const record = { id: createHash('sha256').update(key).digest('hex'), key, ownerId: binding.ownerId, lifecycle: 'open', createdAt, version: 1,
        url: url.href, creationUrl: url.href, zoom: 100, link: { pageId, tabId, scopeId, hostId: binding.hostId }, runtime: { kind: 'starting', generation: 0, operationId: identity } };
      draft.pages.push(record); return prepared = { record: structuredClone(record), changed: true };
    }, { ownerId: binding.ownerId, keys: [key] });
    for (const [owner, state] of service.store.account(binding.ownerId).states) service.states.set(owner, state);
    if (!service.pages.has(key)) service.pages.set(key, { ...committed.record, controller: null, live: false });
    if (committed.changed) service.metadataChanged(binding.ownerId);
    const result = await service.activatePage({ ownerId: binding.ownerId, key, input: { metadataRequired: true }, authorize });
    authorize();
    return { tabId: committed.record.link.tabId, pageId: committed.record.link.pageId, url: result.page.url, visible: false, placement: 'right', runtime: 'live' };
  } catch (error) {
    // A reported failure may follow a known committed draft.
    // Reconcile that committed identity without issuing any native action.
    const durable = service.store.account(binding.ownerId).pages.find(p => p.key === key && p.creationUrl === url.href);
    // Query-scoped reducer facts may have been replaced by another account
    // while this caller awaited publication. Never use that cache here.
    const retired = !committed && prepared && !durable
      ? await service.store.hasRetirement(key).catch(() => false) : false;
    if (!committed && prepared && (durable || retired)) {
      committed = prepared;
      for (const [owner, state] of service.store.account(binding.ownerId).states) service.states.set(owner, state);
      if (durable && !service.pages.has(key)) service.pages.set(key, { ...structuredClone(durable), controller: null, live: false });
      if (prepared.changed) service.metadataChanged(binding.ownerId);
    }
    if (committed) Object.assign(error, { retryable: false, outcome: 'unknown', tabId: committed.record.link.tabId,
      message: `${error.message}. Logical tab ${committed.record.link.tabId} is committed; use list_tabs to inspect its status before another creation.` });
    throw error;
  } finally { release(); }
}
