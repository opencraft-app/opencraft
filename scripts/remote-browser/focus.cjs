'use strict';

// Focus emulation is per renderer target. A main-frame command alone does not
// reach cross-site OOPIFs. Keep this private debugger attached for each page;
// no DOM editor state or public CDP port is involved.
async function initializeNativeFocus(wc, onFailure) {
  const debuggerPort = wc.debugger, sessions = new Set();
  const attach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: 'iframe' }, { exclude: true }] };
  let disposed = false;
  const command = (method, input, session) => debuggerPort.sendCommand(method, input, session);
  const onMessage = (_event, method, params) => {
    if (disposed) return;
    if (method === 'Target.detachedFromTarget') { sessions.delete(params.sessionId); return; }
    if (method !== 'Target.attachedToTarget' || params.targetInfo?.type !== 'iframe') return;
    const session = params.sessionId;
    sessions.add(session);
    void (async () => {
      try {
        await command('Emulation.setFocusEmulationEnabled', { enabled: true }, session);
        if (disposed || !sessions.has(session)) return;
        // A newly attached OOPIF can itself contain another renderer target.
        await command('Target.setAutoAttach', attach, session);
      } catch {
        if (!disposed && sessions.has(session) && !wc.isDestroyed()) onFailure();
      } finally {
        // Never leave a website paused if initialization failed or raced detach.
        try { await command('Runtime.runIfWaitingForDebugger', {}, session); } catch {}
      }
    })();
  };
  const dispose = () => { disposed = true; sessions.clear(); debuggerPort.off('message', onMessage); };
  try {
    if (!debuggerPort.isAttached()) debuggerPort.attach('1.3');
    debuggerPort.on('message', onMessage);
    await command('Emulation.setFocusEmulationEnabled', { enabled: true });
    await command('Target.setAutoAttach', attach);
    return dispose;
  } catch (error) { dispose(); throw error; }
}
module.exports = { initializeNativeFocus };
