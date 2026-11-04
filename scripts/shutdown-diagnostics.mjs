import { performance } from 'node:perf_hooks';

/** Observe disposal without changing its completion or writer-release authority.
 * Callers supply static stage names; no request, identity or error text is logged. */
export function createShutdownDiagnostics(component, {
  report = value => console.info('[opencraft shutdown]', JSON.stringify(value)),
  now = () => performance.now(), waitingMs = 5_000,
} = {}) {
  return async (stage, dispose) => {
    const started = now();
    const emit = phase => {
      try { report({ component, stage, phase, elapsedMs: Math.max(0, Math.round(now() - started)) }); }
      catch { /* Diagnostics cannot skip or fail cleanup. */ }
    };
    emit('started');
    const timer = setInterval(() => emit('waiting'), waitingMs); timer.unref();
    try { const value = await dispose(); emit('completed'); return value; }
    catch (error) { emit('failed'); throw error; }
    finally { clearInterval(timer); }
  };
}
