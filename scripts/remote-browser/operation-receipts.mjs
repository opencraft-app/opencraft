import { createHash } from 'node:crypto';
import { sessionError } from '../remote-browser-state-file.mjs';
const writes = new Set(['navigate', 'back', 'forward', 'reload', 'stop', 'click', 'fill', 'press', 'scroll']);
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const fail = (code, message, outcome = 'unknown') => Object.assign(sessionError(code, message), { outcome });
/** Immutable invocation identity, separate from physical-effect completion.
 * A composite open may create, navigate and present, but may never change its
 * original tool arguments. Observations do not allocate durable receipts. */
export async function bindBrowserInvocation(service, binding, tool, input, { signal } = {}) {
  if (typeof binding?.authorize !== 'function' || ['ownerId', 'hostId', 'threadId', 'turnId', 'callId'].some(key => typeof binding[key] !== 'string' || !binding[key]))
    throw fail('TAB_ACCESS_DENIED', 'Browser invocation requires admitted execution identity', 'not-dispatched');
  const authorize = () => { signal?.throwIfAborted(); binding.authorize(); };
  authorize(); await service.load(); authorize();
  const key = JSON.stringify([binding.ownerId, binding.hostId, binding.threadId, binding.turnId, binding.callId]);
  const id = createHash('sha256').update(JSON.stringify([key, 'invocation-binding'])).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify(stable({ tool, input }))).digest('hex');
  await service.store.transactOperation(binding.ownerId, id, previous => {
    authorize();
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw fail('OPERATION_CONFLICT', 'Browser call identity reused with different input', 'not-dispatched');
      return {};
    }
    // Completed means the binding is sealed, never that a page effect succeeded.
    return { receipt: { id, ownerId: binding.ownerId, method: 'invocation-binding', key, fingerprint, status: 'completed' } };
  });
  authorize();
}

/** A native effect cannot be retried just because its response disappeared.
 * Read-only observations remain receipt-free. Legacy trusted callers without a
 * call identity preserve their existing API; every platform adapter supplies it. */
export async function invokeWithReceipt(service, binding, method, input, options, dispatch) {
  if (!writes.has(method) || !binding?.callId) return dispatch();
  if (typeof binding.authorize !== 'function' || ['ownerId', 'hostId', 'threadId', 'turnId', 'callId', 'lease', 'scopeId'].some(key => typeof binding[key] !== 'string' || !binding[key]))
    throw fail('TAB_ACCESS_DENIED', 'Browser operation requires admitted execution identity', 'not-dispatched');
  options?.signal?.throwIfAborted(); binding.authorize(); await service.load(); binding.authorize();
  const key = JSON.stringify([binding.ownerId, binding.lease]);
  const tabs = await service.conversationTabs(binding.ownerId, binding.hostId, binding.threadId, binding.authorize);
  if (!tabs.some(tab => tab.lease === binding.lease && tab.scopeId === binding.scopeId)) throw fail('TAB_ACCESS_DENIED', 'Browser operation is outside the admitted conversation', 'not-dispatched');
  const id = createHash('sha256').update(JSON.stringify([binding.ownerId, binding.hostId, binding.threadId, binding.turnId, binding.callId, 'effect'])).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify(stable({ method, key, input }))).digest('hex');
  const admission = await service.store.transactOperation(binding.ownerId, id, previous => {
    options?.signal?.throwIfAborted(); binding.authorize();
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw fail('OPERATION_CONFLICT', 'Browser call identity reused with different input', 'not-dispatched');
      return { result: { previous } };
    }
    return { receipt: { id, ownerId: binding.ownerId, method, key, fingerprint, status: 'admitted' }, result: { admitted: true } };
  });
  if (admission.previous) {
    options?.signal?.throwIfAborted(); binding.authorize();
    if (admission.previous.status === 'completed') return { completed: true, ...(method === 'navigate' || ['back', 'forward', 'reload', 'stop'].includes(method) ? { accepted: true } : {}) };
    throw fail(admission.previous.code ?? 'BROWSER_OUTCOME_UNKNOWN', 'Browser operation has a durable receipt; inspect the tab before another input', admission.previous.status === 'failed' ? 'not-dispatched' : 'unknown');
  }
  let result, dispatched = false;
  try {
    options?.signal?.throwIfAborted(); binding.authorize();
    dispatched = true;
    result = await dispatch();
  } catch (error) {
    const known = !dispatched || error.outcome === 'not-dispatched';
    await service.store.transactOperation(binding.ownerId, id, previous => ({ receipt: { ...previous, status: known ? 'failed' : 'unknown',
      code: typeof error.code === 'string' ? error.code : 'BROWSER_OUTCOME_UNKNOWN' } })).catch(() => {});
    if (!dispatched) throw Object.assign(new Error(error.message, { cause: error }), {
      code: options?.signal?.aborted ? 'BROWSER_ABORTED' : error.code ?? 'TAB_ACCESS_DENIED', outcome: 'not-dispatched', retryable: false,
    });
    throw error;
  }
  try {
    await service.store.transactOperation(binding.ownerId, id, previous => ({ receipt: { ...previous, status: 'completed' } }));
  } catch (error) { throw Object.assign(error, { outcome: 'unknown', retryable: false }); }
  return result;
}
