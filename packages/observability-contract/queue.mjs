import { limits, sanitizeEvent } from './index.mjs';
/** emit is synchronous, bounded, and never waits for a transport or disk. */
export function createEventQueue({ maxEvents = limits.queueEvents, maxBytes = limits.queueBytes, now = Date.now } = {}) {
  let bytes = 0, rejected = 0, dropped = 0;
  const pending = [];
  return {
    emit(input) {
      const event = sanitizeEvent(input, now());
      if (!event) { rejected++; return false; }
      const size = new TextEncoder().encode(JSON.stringify(event)).length;
      if (pending.length >= maxEvents || bytes + size > maxBytes) { dropped++; return false; }
      pending.push({ event, size }); bytes += size; return true;
    },
    take() {
      const result = []; let size = 13;
      while (pending.length && result.length < limits.batchEvents && size + pending[0].size + 1 <= limits.batchBytes) {
        const next = pending.shift(); bytes -= next.size; size += next.size + 1; result.push(next.event);
      }
      return result;
    },
    stats: () => ({ pending: pending.length, bytes, rejected, dropped }),
  };
}
