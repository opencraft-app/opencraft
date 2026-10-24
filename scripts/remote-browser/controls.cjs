'use strict';

// A page has one ordered control stream. Only adjacent, not-yet-dispatched
// pointer positions may replace one another; adjacent wheel deltas accumulate.
// Gesture edges and editing never merge.
function createControls(command, getDocument = () => undefined) {
  const tails = new Map(), moves = new Map(), epochs = new Map();
  const ordered = new Set(['input', 'text', 'ime', 'copy', 'viewport', 'visible', 'zoom', 'close', 'control']);
  const dispatch = message => {
    const page = message.page;
    if (['input', 'text', 'ime'].includes(message.method))
      message = { ...message, document: message.document ?? getDocument(page) };
    if (!epochs.has(page)) epochs.set(page, {});
    const epoch = epochs.get(page);
    const move = message.method === 'input' && ['mouseMove', 'touchMove'].includes(message.input?.type);
    const wheel = message.method === 'input' && message.input?.type === 'mouseWheel';
    const signature = move || wheel ? JSON.stringify([wheel ? [message.input.x, message.input.y] : null, message.control, message.document, message.input.type, message.input.button, message.input.modifiers, message.input.pointerType, Array.isArray(message.input.touchPoints) ? message.input.touchPoints.map(p => p?.id).sort((a, b) => a - b) : null]) : null;
    const previous = moves.get(page);
    if ((move || wheel) && previous?.signature === signature) {
      const deltas = {};
      const mergeWheel = wheel && ['deltaX', 'deltaY'].every(axis => {
        const a = previous.message.input[axis] ?? 0, b = message.input[axis] ?? 0;
        deltas[axis] = a + b;
        return Number.isFinite(a) && Number.isFinite(b) && a * b >= 0 && Math.abs(a + b) <= 10000;
      });
      if (move || mergeWheel) {
        previous.message = wheel ? { ...message, input: { ...message.input, ...deltas } } : message;
        return previous.operation;
      }
    }
    // Even unordered navigation is a coalescing boundary.
    moves.delete(page);
    if (!ordered.has(message.method) && message.control === undefined) return command(message);
    const slot = { message, signature };
    const operation = (tails.get(page) ?? Promise.resolve()).then(() => {
      if (epochs.get(page) !== epoch)
        throw Object.assign(new Error('Browser renderer replaced'), { code: 'BROWSER_UNAVAILABLE', retryable: true });
      if (message.document !== undefined && message.document !== getDocument(page))
        throw Object.assign(new Error('Browser document changed'), { code: 'DOCUMENT_CHANGED', retryable: true });
      if (moves.get(page) === slot) moves.delete(page);
      return command(slot.message);
    });
    slot.operation = operation;
    if (move || wheel) moves.set(page, slot);
    const tail = operation.catch(() => {});
    tails.set(page, tail);
    void tail.then(() => { if (tails.get(page) === tail) tails.delete(page); });
    return operation;
  };
  dispatch.retire = page => { epochs.delete(page); tails.delete(page); moves.delete(page); };
  return dispatch;
}
module.exports = { createControls };
