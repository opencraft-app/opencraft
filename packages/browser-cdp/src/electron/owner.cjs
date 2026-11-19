'use strict';

const owners = new WeakMap();
const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
  filter: [{ type: 'iframe' }, { exclude: true }] };

function failure(code, message, dispatched = false) {
  return Object.assign(new Error(message), { code, retryable: false,
    outcome: dispatched ? 'unknown' : 'not-dispatched' });
}

/** Structural Electron adapter: this module has no Electron or harness import.
 * The physical host creates one owner and lends its port to all consumers. */
function createElectronCdpOwner(contents, options = {}) {
  if (owners.has(contents)) throw failure('CDP_OWNER_EXISTS', 'This browser page already has a CDP owner');
  const debuggerPort = contents.debugger;
  const sessions = new Map(), listeners = new Set(), pending = new Set(), running = new Set();
  let disposed = false, attachedHere = false, configuration = Promise.resolve();
  let terminal = null;
  const assertLive = () => {
    if (terminal) throw terminal;
    if (disposed || contents.isDestroyed()) throw failure('PAGE_CLOSED', 'Browser page is closed');
  };

  // The completion barrier retains native work even if its caller stops waiting.
  // This prevents a late configuration ACK from racing subsequent input.
  function task(operation, callOptions = {}, sessionId) {
    let finished = false, dispatched = false, timer, abort, lastMethod;
    let resolve, reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (abort) callOptions.signal.removeEventListener('abort', abort);
      pending.delete(entry);
      error ? reject(error) : resolve(value);
    };
    const entry = { sessionId, fail: (code, message) => finish(failure(code, message, dispatched)) };
    const assertActive = () => {
      assertLive();
      if (finished) throw failure('CDP_CALL_RETIRED', 'Browser command is no longer admitted', dispatched);
      if (callOptions.signal?.aborted) throw failure('CDP_ABORTED', 'Browser command cancelled', dispatched);
      callOptions.validate?.();
    };
    pending.add(entry);
    const timeout = callOptions.timeoutMs ?? options.timeoutMs ?? 20000;
    timer = setTimeout(() => entry.fail('CDP_TIMEOUT', `Browser command timed out${lastMethod ? `: ${lastMethod}` : ' before dispatch'}`),
      Math.max(1, Math.min(60000, Number.isFinite(timeout) ? timeout : 20000)));
    if (callOptions.signal) {
      abort = () => entry.fail('CDP_ABORTED', 'Browser command cancelled');
      callOptions.signal.addEventListener('abort', abort, { once: true });
      if (callOptions.signal.aborted) abort();
    }
    const send = async (method, params = {}, targetSession = sessionId) => {
      assertActive(); dispatched = true; lastMethod = method;
      return debuggerPort.sendCommand(method, params, targetSession);
    };
    const completion = Promise.resolve().then(() => {
      assertActive(); return operation(send, assertActive);
    }).then(value => { assertActive(); return value; }).then(value => { finish(null, value); return value; }, error => {
      const normalized = failure(error?.code ?? 'CDP_COMMAND_FAILED', error?.message ?? 'Browser command failed', dispatched);
      finish(normalized); throw normalized;
    });
    running.add(completion);
    void completion.finally(() => {
      running.delete(completion);
      if (disposed && running.size === 0 && owners.get(contents) === owner) owners.delete(contents);
    }).catch(() => {});
    // A caller can time out before Chromium settles. Always observe late errors.
    void completion.catch(() => {});
    return { result, completion };
  }

  const reportFailure = error => { try { options.onFailure?.(error); } catch {} };
  function initialize(sessionId) {
    const job = task(async (send, check) => {
      await options.initializeTarget?.((method, params) => send(method, params, sessionId), sessionId);
      check();
      if (sessionId && !sessions.has(sessionId)) throw failure('STALE_TARGET', 'Browser frame was detached');
      await send('Target.setAutoAttach', autoAttach, sessionId);
    }, {}, sessionId);
    return job.result.finally(async () => {
      // Release a paused child even if a native initialization command hangs.
      if (sessionId) {
        try { await debuggerPort.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId); } catch {}
      }
    });
  }

  const onMessage = (_event, method, params = {}, sessionId) => {
    if (disposed || terminal) return;
    if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe'
      && typeof params.sessionId === 'string') {
      const state = { targetId: params.targetInfo.targetId, parentSessionId: sessionId, ready: null };
      sessions.set(params.sessionId, state);
      state.ready = initialize(params.sessionId);
      void state.ready.catch(error => {
        if (!disposed && !terminal && sessions.get(params.sessionId) === state) reportFailure(error);
      });
    } else if (method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string') {
      // Chromium can retire a parent target without emitting separate detach
      // events for all flattened descendant sessions on the root connection.
      const retired = new Set([params.sessionId]);
      let changed;
      do {
        changed = false;
        for (const [id, state] of sessions) if (retired.has(state.parentSessionId) && !retired.has(id)) {
          retired.add(id); changed = true;
        }
      } while (changed);
      for (const id of retired) sessions.delete(id);
      for (const entry of [...pending]) if (retired.has(entry.sessionId))
        entry.fail('STALE_TARGET', 'Browser frame was detached');
    }
    const event = { method, params, ...(sessionId ? { sessionId, targetId: sessions.get(sessionId)?.targetId } : {}) };
    for (const listener of listeners) { try { listener(event); } catch (error) { reportFailure(error); } }
  };
  function retire(code, message, cause) {
    if (disposed || terminal) return;
    terminal = failure(code, message);
    if (cause) terminal.cause = cause;
    for (const entry of [...pending]) entry.fail(code, message);
    sessions.clear();
    reportFailure(terminal);
  }
  const onDetach = () => retire('CDP_DISCONNECTED', 'Browser debugger disconnected');
  const onDestroyed = () => retire('PAGE_CLOSED', 'Browser page is closed');
  const onRendererGone = () => retire('PAGE_CLOSED', 'Browser renderer exited');

  const owner = {
    ready: null,
    send(method, params = {}, sessionId, callOptions) {
      return task(async (send, check) => {
        await owner.ready; check();
        const target = sessionId ? sessions.get(sessionId) : null;
        if (sessionId && !target) throw failure('STALE_TARGET', 'Browser frame is not attached');
        if (target) { await target.ready; check(); }
        let barrier;
        do { barrier = configuration; await barrier; check(); } while (barrier !== configuration);
        if (target && sessions.get(sessionId) !== target) throw failure('STALE_TARGET', 'Browser frame was replaced');
        return send(method, params, sessionId);
      }, callOptions, sessionId).result;
    },
    configure(operation, callOptions) {
      const previous = configuration;
      const job = task(async (send, check) => {
        await owner.ready;
        // A replacement configuration may repair a failed earlier one, but
        // only after its underlying native operation has actually settled.
        await previous.catch(() => {}); check();
        return operation(send);
      }, callOptions);
      configuration = job.completion;
      return job.result;
    },
    subscribe(listener) {
      assertLive(); listeners.add(listener);
      return () => listeners.delete(listener);
    },
    targetSessions() {
      return [...sessions].map(([sessionId, state]) => ({ sessionId, targetId: state.targetId }));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of [...pending]) entry.fail('PAGE_CLOSED', 'Browser CDP owner was disposed');
      debuggerPort.off('message', onMessage); debuggerPort.off('detach', onDetach);
      contents.off('destroyed', onDestroyed); contents.off('render-process-gone', onRendererGone);
      sessions.clear(); listeners.clear();
      // Unknown native work cannot be adopted by a replacement owner yet.
      if (running.size === 0) owners.delete(contents);
      if (attachedHere && !contents.isDestroyed() && debuggerPort.isAttached()) {
        try { debuggerPort.detach(); } catch {}
      }
    },
  };
  owners.set(contents, owner);
  debuggerPort.on('message', onMessage); debuggerPort.on('detach', onDetach);
  contents.on('destroyed', onDestroyed); contents.on('render-process-gone', onRendererGone);
  owner.ready = Promise.resolve().then(async () => {
    assertLive();
    if (!debuggerPort.isAttached()) { debuggerPort.attach('1.3'); attachedHere = true; }
    await initialize();
    assertLive();
  });
  void owner.ready.catch(error => retire('CDP_INITIALIZATION_FAILED', 'Browser CDP initialization failed', error));
  return owner;
}

module.exports = { createElectronCdpOwner };
