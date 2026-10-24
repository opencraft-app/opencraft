/** Per-socket liveness. A queued Ping is not yet a probe of the peer. */
export function trackSocketHeartbeat(socket, { intervalMs, now = Date.now, diagnostic = () => {} }) {
  let sequence = 0, pending = null, closed = false, lastPongAt = now();
  const report = (event, extra = {}) => {
    try { diagnostic(event, { bufferedBytes: socket.bufferedAmount, lastPongAgeMs: now() - lastPongAt, ...extra }); } catch { /* Observation cannot close a connection. */ }
  };
  const stop = (event, extra) => { report(event, extra); closed = true; pending = null; socket.terminate(); };
  socket.on('close', () => { closed = true; pending = null; });
  socket.on('pong', data => {
    if (!pending || String(data) !== pending.token) return;
    const probe = pending; pending = null; lastPongAt = now();
    probe.sentAt ??= lastPongAt;
    // Healthy idle sockets stay quiet; retain the outcome of delayed probes.
    if (probe.delayed) report('heartbeat-recovered', { sequence: probe.sequence, queuedMs: probe.sentAt - probe.queuedAt, roundTripMs: now() - probe.sentAt });
  });
  return () => {
    if (closed || socket.readyState !== 1) return;
    const time = now();
    if (pending) {
      const probe = pending;
      if (probe.sentAt === null) {
        const bytes = socket.bufferedAmount;
        if (bytes < probe.bufferedBytes) probe.progressAt = time;
        probe.bufferedBytes = bytes;
        if (!probe.delayed) { probe.delayed = true; report('heartbeat-write-pending', { sequence: probe.sequence, queuedMs: time - probe.queuedAt }); }
        if (time - probe.progressAt >= intervalMs * 4) stop('heartbeat-write-stalled', { sequence: probe.sequence, queuedMs: time - probe.queuedAt, stalledMs: time - probe.progressAt });
        return;
      }
      // Even a newly admitted socket gets a full interval after Ping is flushed.
      if (time - probe.sentAt < intervalMs) return;
      stop('heartbeat-timeout', { sequence: probe.sequence, queuedMs: probe.sentAt - probe.queuedAt, sentAgeMs: time - probe.sentAt });
      return;
    }
    const probe = { sequence: ++sequence, token: String(sequence), queuedAt: time, sentAt: null,
      bufferedBytes: socket.bufferedAmount, progressAt: time, delayed: false };
    pending = probe;
    try {
      socket.ping(probe.token, undefined, error => {
        if (closed || pending !== probe) return;
        if (error) { stop('heartbeat-write-failed', { sequence: probe.sequence }); return; }
        probe.sentAt = now();
        if (probe.delayed || probe.sentAt - probe.queuedAt >= intervalMs) {
          probe.delayed = true;
          report('heartbeat-sent', { sequence: probe.sequence, queuedMs: probe.sentAt - probe.queuedAt });
        }
      });
    } catch { stop('heartbeat-write-failed', { sequence: probe.sequence }); }
  };
}
