'use strict';

// A gap belongs to one viewer, never to the shared prediction stream. Do not
// queue stale pictures or send deltas whose reference pictures were skipped.
function createDisplayFlow({ keyframe, diagnose, now = Date.now }) {
  const flows = new Map();
  const low = 64 * 1024, high = 128 * 1024, hard = 4 * 1024 * 1024;
  const clear = ws => { const flow = flows.get(ws); clearTimeout(flow?.timer); flows.delete(ws); };
  const close = ws => {
    clear(ws); diagnose('display_stalled');
    ws.close(1013, 'Display stalled; reconnecting');
    // Give the close frame time to drain. Immediate terminate hides the cause
    // behind an abnormal 1006 even when the peer can receive a close frame.
    const timer = setTimeout(() => ws.terminate(), 2000); timer.unref();
    ws.once('close', () => clearTimeout(timer));
  };
  function poll(ws, flow) {
    if (flows.get(ws) !== flow) return;
    if (ws.readyState !== 1 || !flow.viewer.visible) { clear(ws); return; }
    if (now() - flow.since >= 10000 || ws.bufferedAmount > hard) { close(ws); return; }
    if (ws.bufferedAmount <= low && now() - flow.requested >= 1000) {
      flow.requested = now(); keyframe(flow.page);
    }
    flow.timer = setTimeout(() => poll(ws, flow), 100); flow.timer.unref();
  }
  return {
    send(page, ws, viewer, packet, event) {
      if (ws.bufferedAmount > hard) { close(ws); return; }
      let flow = flows.get(ws);
      if (packet && !flow && ws.bufferedAmount > high) {
        flow = { page, viewer, since: now(), requested: -Infinity, timer: null };
        flows.set(ws, flow); diagnose('display_paused'); poll(ws, flow);
      }
      if (packet && flow) {
        if (packet[0] !== 1 || ws.bufferedAmount > low) return;
        clear(ws); diagnose('display_resumed');
      }
      ws.send(packet ?? JSON.stringify(event), { binary: !!packet });
    },
    detach: clear,
    close() { for (const ws of flows.keys()) clear(ws); },
  };
}
module.exports = { createDisplayFlow };
