/** Direct-owner probe RPC. A parsed reply is consumed only after its exact
 * receipt has been flushed to the socket, including errors and late replies.
 * Use graceful socket.close() after the probe; terminate() may discard ACKs. */
export function ownerProbeRpc(socket, { timeoutMs = 15000 } = {}) {
  let sequence = 0;
  const pending = new Map(), awaitingReplies = new Set();
  const fail = error => {
    for (const row of pending.values()) { clearTimeout(row.timer); row.reject(error); }
    pending.clear(); awaitingReplies.clear();
  };
  socket.on('close', () => fail(new Error('Owner probe connection closed')));
  socket.on('error', fail);
  socket.on('message', async raw => {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { return; }
    if (!frame || frame.method || !awaitingReplies.has(frame.id)) return;
    const row = pending.get(frame.id);
    try {
      if (frame.opencraftDshReceipt) {
        await new Promise((resolve, reject) => socket.send(JSON.stringify({
          method: 'opencraft/owner/receipt', params: frame.opencraftDshReceipt,
        }), error => error ? reject(error) : resolve()));
      }
      awaitingReplies.delete(frame.id);
      if (!row || pending.get(frame.id) !== row) return;
      pending.delete(frame.id); clearTimeout(row.timer);
      frame.error ? row.reject(new Error('Owner probe RPC rejected')) : row.resolve(frame.result);
    } catch (error) { fail(error); }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; awaitingReplies.add(id);
    const timer = setTimeout(() => {
      pending.delete(id); reject(new Error('Owner probe RPC timeout'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }), error => {
      if (!error) return;
      const row = pending.get(id);
      if (row) { pending.delete(id); clearTimeout(row.timer); row.reject(error); }
    });
  });
}
