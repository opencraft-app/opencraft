'use strict';
const { randomUUID } = require('node:crypto');
const { MediaFlow } = require('@opencraft/remote-interaction/server');
const { EncodingBuckets } = require('@opencraft/remote-interaction/policy');

// A gap belongs to one viewer, never to the shared prediction stream. Do not
// queue stale pictures or send deltas whose reference pictures were skipped.
function createDisplayFlow({ keyframe, diagnose, pace = () => {}, bounds, now = () => performance.now() }) {
  const flows = new Map();
  const receivers = new Map();
  const budgets = new WeakMap();
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
    attach(page, ws, viewer, stage) {
      if (!['received', 'rendered'].includes(stage) || receivers.has(ws)) return;
      let media;
      media = new MediaFlow({ stage, epoch: randomUUID, now,
        configure: config => { if (ws.readyState === 1) ws.send(JSON.stringify(config)); },
        keyframe: () => { if (viewer.visible) keyframe(page, media?.bucket ?? 'fast'); },
        close: () => close(ws),
        pace: fps => { if (viewer.decodeFps !== fps) { viewer.decodeFps = fps; pace(page); } } });
      const timer = setInterval(() => {
        if (ws.readyState !== 1) return;
        try {
          viewer.authorize?.();
          if (ws.bufferedAmount > hard) { close(ws); return; }
          if (viewer.visible) media.tick();
          pace(page);
        } catch { ws.close(1008, 'Browser admission expired'); }
      }, 250); timer.unref();
      receivers.set(ws, { media, timer, page, viewer, stable: null, switched: -Infinity });
      viewer.bucket = 'fast';
    },
    feedback(ws, input) {
      const entry = receivers.get(ws); if (!entry) return false;
      const accepted = entry.media.feedback(input); if (accepted) pace(entry.page); return accepted;
    },
    snapshot(ws) { return receivers.get(ws)?.media.snapshot() ?? null; },
    production(page) {
      const consumers = [];
      for (const [ws, viewer] of page.viewers ?? []) {
        if (!viewer.visible || !viewer.ready || ws.readyState !== 1) continue;
        const entry = receivers.get(ws), status = entry?.media.snapshot();
        if (entry && page.productionDemand) {
          const slow = status.requestedFps <= 15 || status.pressure || (status.feedbackDelayMs ?? 0) > 400;
          if (slow) entry.stable = null;
          else if (status.recentProgress) entry.stable ??= now();
          else entry.stable = null;
          const desired = slow ? 'slow' : entry.stable !== null && now() - entry.stable >= 20000 ? 'fast' : status.bucket;
          if (desired !== status.bucket && now() - entry.switched >= (desired === 'slow' ? 1000 : 20000)
            && entry.media.switchBucket(desired)) { viewer.bucket = desired; entry.switched = now(); }
        }
        const current = entry?.media.snapshot();
        consumers.push({ bucket: page.productionDemand ? viewer.bucket ?? 'fast' : 'fast',
          fps: current?.fps ?? 30, allowed: entry ? entry.media.capacity() : true,
          pressure: current?.pressure ?? false, progress: current?.recentProgress ?? false });
      }
      let budget = budgets.get(page); if (!budget) { budget = new EncodingBuckets(bounds); budgets.set(page, budget); }
      return budget.plan(consumers, now());
    },
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
      if (packet && receivers.has(ws) && !receivers.get(ws).media.admit(packet)) return;
      ws.send(packet ?? JSON.stringify(event), { binary: !!packet });
      if (packet) pace(page);
    },
    detach(ws) {
      clear(ws);
      const receiver = receivers.get(ws);
      if (receiver) { clearInterval(receiver.timer); receiver.media.dispose(); receivers.delete(ws); }
    },
    close() {
      for (const ws of flows.keys()) clear(ws);
      for (const { media, timer } of receivers.values()) { clearInterval(timer); media.dispose(); }
      receivers.clear();
    },
  };
}
module.exports = { createDisplayFlow };
