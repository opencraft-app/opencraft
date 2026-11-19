'use strict';

const cancelled = () => Object.assign(new Error('Browser automation cancelled'), {
  code: 'CDP_ABORTED', retryable: false, outcome: 'not-dispatched',
});

/** Private owner-channel requests, registered before entering the page queue.
 * Cancellation bypasses that queue; it never replays input or destroys a page.
 */
function createAutomationRequests() {
  const pending = new Map();
  return {
    run(message, dispatch) {
      if (message.method !== 'automation') return Promise.resolve().then(() => dispatch(message));
      if (typeof message.id !== 'string' || pending.has(message.id)) return Promise.reject(new Error('Invalid automation request identity'));
      if (pending.size >= 256 || [...pending.values()].filter(call => call.page === message.page).length >= 32)
        return Promise.reject(Object.assign(new Error('Browser automation backlog'), { code: 'BROWSER_BUSY', retryable: false, outcome: 'not-dispatched' }));
      const controller = new AbortController();
      const entry = { page: message.page, control: message.control, controller }; pending.set(message.id, entry);
      return Promise.resolve().then(() => {
        if (controller.signal.aborted) throw cancelled();
        return dispatch({ ...message, signal: controller.signal });
      }).finally(() => { if (pending.get(message.id) === entry) pending.delete(message.id); });
    },
    cancel(page, id) {
      const entry = pending.get(id);
      if (entry?.page === page) entry.controller.abort();
    },
    /** Only the synchronous native navigation dispatch may cross the document
     * replacement it triggers. Queued navigation still belongs to the old doc. */
    navigating(id, operation) {
      const entry = pending.get(id);
      if (!entry || entry.controller.signal.aborted) throw cancelled();
      entry.navigating = true;
      return operation(); // run.finally retires the exemption with the request.
    },
    documentChanged(page) {
      for (const entry of pending.values())
        if (entry.page === page && !entry.navigating) entry.controller.abort();
    },
    retire(page, predicate = () => true) {
      for (const entry of pending.values()) if (entry.page === page && predicate(entry.control)) entry.controller.abort();
    },
  };
}
module.exports = { createAutomationRequests };
