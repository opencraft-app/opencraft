import { sessionError, sessionLink, conversationScopes } from '../remote-browser-state-file.mjs';

const readOnly = new Set(['inspect', 'readContext', 'wait', 'capture', 'activate']);
const navigation = new Set(['navigate', 'back', 'forward', 'reload', 'stop']);
const methods = new Set([...readOnly, ...navigation, 'click', 'fill', 'press', 'scroll']);
const denied = () => Object.assign(sessionError('TAB_ACCESS_DENIED', 'Browser tab is outside the admitted conversation'), { outcome: 'not-dispatched' });

/** Host-only invocation on an existing native tab. The composition supplies
 * authenticated account/scope/host identity and a live authorization guard.
 * Missing native pages recover through the same lifecycle as viewer attachment.
 * No viewer, media subscription or second native owner is created.
 */
export async function invokeRemoteAutomation(service, binding, method, input, { signal } = {}) {
  if (!methods.has(method)) throw sessionError('INVALID_ARGUMENT', 'Unsupported browser automation method');
  if (method === 'navigate') {
    let url; try { url = new URL(input?.url); } catch {}
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw Object.assign(sessionError('INVALID_ARGUMENT', 'Navigation requires an absolute http(s) URL'), { outcome: 'not-dispatched' });
  }
  if (!binding || typeof binding.authorize !== 'function'
    || ['ownerId', 'lease', 'scopeId', 'hostId'].some(key => typeof binding[key] !== 'string' || !binding[key])) throw denied();
  const { ownerId, lease, scopeId, hostId, authorize } = binding;
  signal?.throwIfAborted(); authorize(); await service.load();
  const key = JSON.stringify([ownerId, lease]);
  const checkScope = () => {
    authorize();
    const state = service.store.account(ownerId).states[0]?.[1];
    const link = sessionLink(state, lease);
    if (service.closed || !link || link.scopeId !== scopeId || link.hostId !== hostId) throw denied();
    if (binding.threadId !== undefined && !conversationScopes(state, hostId, binding.threadId).has(scopeId)) throw denied();
  };
  checkScope(); await service.start(); checkScope(); signal?.throwIfAborted();
  if (service.ownerConnector && service.child?.automationCancellation !== 1)
    throw Object.assign(sessionError('BROWSER_OWNER_INCOMPATIBLE', 'Close retained browser tabs before upgrading their owner for service automation'), { outcome: 'not-dispatched' });
  if (navigation.has(method) && service.ownerConnector && service.child?.automationNavigation !== 1)
    throw Object.assign(sessionError('BROWSER_OWNER_INCOMPATIBLE', 'Retained browser runtime does not support cancellable service navigation; close its tabs before upgrading'), { outcome: 'not-dispatched' });
  // Share bootstrap serialization with real viewers; never synthesize an
  // attachment, change a live tab's viewport or replay an uncertain creation.
  if (!service.pages.get(key)?.live || service.attachments.has(key)) {
    const release = await service.acquirePageActivation(key);
    try {
      checkScope(); signal?.throwIfAborted();
      if (!service.pages.get(key)?.live)
        await service.activatePage({ ownerId, key, input: { metadataRequired: true }, authorize: () => { checkScope(); signal?.throwIfAborted(); } });
    } finally { release(); }
  }
  checkScope(); signal?.throwIfAborted();
  const page = service.pages.get(key);
  if (!page?.live || page.closing || !page.document)
    throw Object.assign(sessionError('BROWSER_UNAVAILABLE', 'Browser tab has no live native document'), { outcome: 'not-dispatched' });
  if (method === 'activate') return { active: true };
  const document = page.document, epoch = page.runtimeEpoch ?? 0, native = service.child;
  const controller = new AbortController(), participant = Object.freeze({ kind: 'service-agent' });
  let token, finished = false;
  const current = () => !finished && !controller.signal.aborted && !service.closed && !page.closing && page.live
    && service.pages.get(key) === page && service.child === native && (page.runtimeEpoch ?? 0) === epoch
    && (navigation.has(method) || page.document === document)
    && (token === undefined || page.controller === participant && page.controlToken === token);
  const validate = () => { checkScope(); if (!current()) throw sessionError('DOCUMENT_CHANGED', 'Browser invocation expired'); };
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  // Authorization can expire while Chromium is awaiting a selector or layout.
  const watcher = setInterval(() => { try { validate(); } catch { abort(); } }, 100); watcher.unref();
  try {
    validate();
    if (!readOnly.has(method)) {
      const grant = await service.changeControl(page, participant, { action: 'agent' }, validate, current);
      token = grant.token; validate();
    }
    const result = await service.request(page.id, 'automation', { method, input }, token, document, { signal: controller.signal });
    validate();
    if (token && (page.controller !== participant || page.controlToken !== token)) throw sessionError('CONTROL_LOST', 'Browser control changed');
    return result;
  } finally {
    clearInterval(watcher); signal?.removeEventListener('abort', abort); finished = true;
    if (token && page.controller === participant && page.controlToken === token)
      await service.changeControl(page, participant, { action: 'release', token }, () => {},
        () => !service.closed && !page.closing && service.pages.get(key) === page).catch(error => {
          throw Object.assign(error, { retryable: false, outcome: 'unknown' });
        });
  }
}
