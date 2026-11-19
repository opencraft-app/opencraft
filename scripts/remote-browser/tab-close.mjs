import { sessionError, sessionLink, conversationScopes } from '../remote-browser-state-file.mjs';

const denied = () => Object.assign(sessionError('TAB_ACCESS_DENIED', 'Browser tab is outside the admitted conversation'), { outcome: 'not-dispatched' });
const cancelled = () => Object.assign(sessionError('BROWSER_ABORTED', 'Browser close is committed and continues; inspect the resource directory'), { retryable: false, outcome: 'unknown' });
function waitForRetirement(operation, signal) {
  // The native cleanup remains owned and observed after the caller stops waiting.
  return new Promise((resolve, reject) => {
    const abort = () => { signal?.removeEventListener('abort', abort); reject(cancelled()); };
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    operation.then(value => { signal?.removeEventListener('abort', abort); resolve(value); }, error => {
      signal?.removeEventListener('abort', abort); reject(Object.assign(error, { retryable: false, outcome: 'unknown' }));
    });
  });
}

/** Conversation close is a resource-owner operation, not document automation.
 * Agent admission shares control arbitration; committed cleanup no longer
 * depends on an execution, viewer connection or document remaining alive. */
export async function closeRemoteTab(service, binding, { tabId }, { signal } = {}) {
  if (!binding || typeof binding.authorize !== 'function' || ['ownerId', 'hostId', 'threadId'].some(k => typeof binding[k] !== 'string' || !binding[k])
    || typeof tabId !== 'string' || !tabId) throw denied();
  const authorize = () => {
    try { signal?.throwIfAborted(); binding.authorize(); if (service.closed) throw denied(); }
    catch (error) { if (error.outcome === undefined) error.outcome = 'not-dispatched'; throw error; }
  };
  authorize(); await service.load(); await service.store.tail; authorize();
  const receipt = service.store.account(binding.ownerId).closedTabs?.find(r => r.ownerId === binding.ownerId && r.tabId === tabId && r.hostId === binding.hostId && r.threadId === binding.threadId);
  if (receipt?.status === 'closed') return { tabId, closed: true };
  const record = receipt ? service.store.account(binding.ownerId).pages.find(p => p.key === receipt.key)
    : service.store.account(binding.ownerId).pages.find(p => p.ownerId === binding.ownerId && p.link?.tabId === tabId);
  if (!record) throw denied();
  const state = () => service.store.account(binding.ownerId).states[0]?.[1];
  const owns = () => {
    authorize();
    const pending = service.store.account(binding.ownerId).closedTabs?.find(r => r.key === record.key);
    if (pending) {
      if (pending.ownerId !== binding.ownerId || pending.tabId !== tabId || pending.hostId !== binding.hostId || pending.threadId !== binding.threadId) throw denied();
      return;
    }
    const link = sessionLink(state(), JSON.parse(record.key)[1]);
    if (!link || link.tabId !== tabId || link.hostId !== binding.hostId || !conversationScopes(state(), binding.hostId, binding.threadId).has(link.scopeId)) throw denied();
  };
  owns();
  const page = service.pages.get(record.key); if (!page) throw denied();
  if (page.retirement || record.lifecycle === 'closing') {
    await waitForRetirement(service.retire(page), signal); return { tabId, closed: true };
  }
  const native = service.child, epoch = page.runtimeEpoch ?? 0;
  const participant = Object.freeze({ kind: 'service-agent' }); let token, committed = false;
  const current = () => !page.closing && service.pages.get(record.key) === page && service.child === native && (page.runtimeEpoch ?? 0) === epoch
    && (token === undefined || page.controller === participant && page.controlToken === token);
  const validate = () => { owns(); if (!current()) throw Object.assign(sessionError('CONTROL_LOST', 'Browser close admission expired'), { outcome: 'not-dispatched' }); };
  try {
    validate();
    if (page.live) {
      const control = await service.changeControl(page, participant, { action: 'agent' }, validate, current);
      token = control.token; validate();
    } else if (page.controller) throw Object.assign(sessionError('CONTROL_BUSY', 'Browser is controlled elsewhere'), { outcome: 'not-dispatched' });
    const { retirement } = await service.controlQueue(page, async () => {
      validate();
      const retirement = service.retire(page, undefined, { admit: validate, threadId: binding.threadId });
      void retirement.catch(() => {});
      await page.retirementIntent; return { retirement };
    });
    committed = true;
    await waitForRetirement(retirement, signal); return { tabId, closed: true };
  } finally {
    if (!committed && !page.closing && token && page.controller === participant && page.controlToken === token)
      await service.changeControl(page, participant, { action: 'release', token }, () => {}, () => !service.closed && !page.closing && service.pages.get(record.key) === page)
        .catch(error => { throw Object.assign(error, { retryable: false, outcome: 'unknown' }); });
  }
}
