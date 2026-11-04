import { randomUUID } from 'node:crypto';

/** Standard WebSocket messages, bounded end-to-end by native Pong credit.
 * A local send callback is not a peer acknowledgement. All application sends
 * on this socket must use this owner; control frames may interleave freely.
 */
export function createWebSocketSender(socket, {
  fragmentBytes = 16 * 1024, windowBytes = 256 * 1024,
  maximumBytes = 128 * 1024 * 1024, maximumMessages = 1024,
  acknowledgementTimeoutMs = 60_000,
} = {}) {
  let queue = [], bytes = 0, credit = windowBytes, writing = false, stopped = false;
  let pending = null, timer = null, scheduled = null;
  const finish = (entry, error) => { try { entry.callback?.(error); } catch { /* A caller cannot strand the sender. */ } };
  const stop = (error = new Error('WebSocket sender closed')) => {
    if (stopped) return;
    stopped = true; clearTimeout(timer); clearImmediate(scheduled);
    socket.off('pong', pong); socket.off('close', close); socket.off('error', stop);
    const abandoned = queue; queue = []; bytes = 0; pending = null;
    for (const entry of abandoned) finish(entry, error);
  };
  const fail = error => { stop(error); socket.terminate(); };
  const close = () => stop();
  const schedule = () => { if (!stopped && scheduled === null) scheduled = setImmediate(() => { scheduled = null; pump(); }); };
  const pong = data => {
    if (pending === null || String(data) !== pending) return;
    pending = null; clearTimeout(timer); timer = null; credit = windowBytes; schedule();
  };
  const pump = () => {
    if (stopped || writing || pending !== null || queue.length === 0) return;
    if (socket.readyState !== 1) { fail(new Error('WebSocket is unavailable')); return; }
    if (credit === 0) {
      pending = `credit:${randomUUID()}`;
      timer = setTimeout(() => fail(new Error('WebSocket peer acknowledgement stalled')), acknowledgementTimeoutMs);
      timer.unref?.();
      try { socket.ping(pending, undefined, error => { if (error) fail(error); }); } catch (error) { fail(error); }
      return;
    }
    const entry = queue[0];
    const end = Math.min(entry.offset + fragmentBytes, entry.data.length, entry.offset + credit);
    const fragment = entry.data.subarray(entry.offset, end);
    const final = end === entry.data.length;
    writing = true;
    try {
      socket.send(fragment, { binary: entry.binary, fin: final, compress: false }, error => {
        writing = false;
        if (stopped) return;
        if (error) { fail(error); return; }
        credit -= fragment.length; entry.offset = end;
        if (final) { queue.shift(); bytes -= entry.data.length; finish(entry); }
        schedule();
      });
    } catch (error) { writing = false; fail(error); }
  };
  socket.on('pong', pong); socket.once('close', close); socket.once('error', stop);
  return (data, callback) => {
    if (stopped) { finish({ callback }, new Error('WebSocket sender closed')); return false; }
    const binary = typeof data !== 'string';
    const length = binary ? data.byteLength : Buffer.byteLength(data);
    if (length > maximumBytes - bytes || queue.length >= maximumMessages) {
      const error = new Error('WebSocket send queue exceeded');
      finish({ callback }, error); fail(error); return false;
    }
    const buffer = binary ? Buffer.from(data) : Buffer.from(data, 'utf8');
    queue.push({ data: buffer, binary, offset: 0, callback }); bytes += length; schedule(); return true;
  };
}
