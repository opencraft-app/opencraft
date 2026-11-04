'use strict';
const { MAX_TOUCH_SAMPLES, TOUCH_SAMPLE_WINDOW_MS } = require('@opencraft/remote-interaction/touch');

const MAX_TOUCH_POINTS = 10;
const types = new Set(['touchStart', 'touchMove', 'touchEnd', 'touchCancel']);
// Electron's OSR wheel path adds phases to a copy, then forwards the original
// unphased event on our pinned runtime. Chromium DCHECKs and aborts the process.
// The private CDP injector supplies begin/end phases and routes through native
// hit testing (including OOPIFs). It takes CSS positions and web delta signs.
function createWidgetWheelDispatcher(debuggerPort, getZoomFactor, getDocument = () => undefined) {
  return async event => {
    const document = getDocument();
    const metrics = await debuggerPort.sendCommand('Page.getLayoutMetrics');
    if (document !== getDocument()) throw Object.assign(new Error('Browser document changed'), { code: 'DOCUMENT_CHANGED', retryable: true });
    const scale = metrics.cssVisualViewport?.scale * getZoomFactor();
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid native wheel scale');
    const modifiers = (event.modifiers ?? []).reduce((bits, modifier) => bits | ({ alt: 1, control: 2, meta: 4, shift: 8 }[modifier] ?? 0), 0);
    return debuggerPort.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: (event.x ?? 0) / scale, y: (event.y ?? 0) / scale,
      deltaX: -(event.deltaX ?? 0), deltaY: -(event.deltaY ?? 0), modifiers,
    });
  };
}
// Viewer coordinates already identify positions in the rendered widget. CDP
// applies browser zoom and pinch scale to its CSS coordinates on injection.
// Read native metrics at dispatch, including while a gesture changes scale;
// a viewer notification or a once-per-gesture snapshot would be stale.
function createWidgetTouchDispatcher(debuggerPort, getZoomFactor, getDocument = () => undefined, nativeInputTickets = () => false) {
  // Wire identities are not Chromium pointer slots (VelocityTracker uses a
  // 32-bit bitset). Keep held contacts stable, even when their wire IDs are
  // large or their snapshot order changes. Commit slots only after native ACK.
  let slots = new Map();
  return async input => {
    const document = getDocument();
    if (input.type === 'touchCancel') {
      try { return await debuggerPort.sendCommand('Input.dispatchTouchEvent', input); }
      finally { slots.clear(); }
    }
    const next = new Map(slots);
    if (input.type === 'touchStart') {
      for (const point of input.touchPoints) {
        if (next.has(point.id)) throw new Error('Duplicate native touch contact');
        let slot = 0;
        while ([...next.values()].includes(slot)) slot++;
        if (slot >= MAX_TOUCH_POINTS) throw new Error('Too many native touch contacts');
        next.set(point.id, slot);
      }
    }
    let touchPoints = input.touchPoints;
    if (touchPoints.length) {
      if (touchPoints.some(point => !next.has(point.id))) throw new Error('Unknown native touch contact');
      const metrics = await debuggerPort.sendCommand('Page.getLayoutMetrics');
      if (document !== getDocument()) throw Object.assign(new Error('Browser document changed'), { code: 'DOCUMENT_CHANGED', retryable: true });
      const scale = metrics.cssVisualViewport?.scale * getZoomFactor();
      if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid native touch scale');
      touchPoints = touchPoints.map(point => ({ ...point, id: next.get(point.id), x: point.x / scale, y: point.y / scale }));
    }
    // Chromium's per-contact dispatcher leaves radius/force in widget units.
    const method = input.type === 'touchEnd' && nativeInputTickets() ? 'Input.dispatchTouchEventWithNativeInputTicket' : 'Input.dispatchTouchEvent';
    const result = await debuggerPort.sendCommand(method, { ...input, touchPoints });
    if (input.type === 'touchEnd') {
      if (!touchPoints.length) next.clear();
      else for (const point of input.touchPoints) next.delete(point.id);
    }
    slots = next;
    return result;
  };
}
function points(input) {
  if (!types.has(input.type) || !Array.isArray(input.touchPoints) || input.touchPoints.length > MAX_TOUCH_POINTS) throw new Error('Invalid touch input');
  const ids = new Set();
  return input.touchPoints.map(point => {
    if (!point || !Number.isInteger(point.id) || point.id < 0 || point.id > 2147483647 || ids.has(point.id)) throw new Error('Invalid touch identity');
    ids.add(point.id);
    const result = { id: point.id };
    for (const [name, minimum, maximum, fallback] of [['x', -10000, 10000], ['y', -10000, 10000], ['radiusX', 0, 1000, 1], ['radiusY', 0, 1000, 1], ['force', 0, 1, 1]]) {
      const value = point[name] ?? fallback;
      if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error('Invalid touch geometry');
      result[name] = value;
    }
    return result;
  });
}

// The worker selects Chromium's per-contact dispatcher. Its touchStart/touchEnd
// describe changed contacts; the wire carries complete active-contact snapshots.
function createTouchInput(dispatch, now = () => Date.now(), getDocument = () => undefined) {
  let active = new Map(), tail = Promise.resolve(), clock = null;
  const enqueue = operation => {
    const result = tail.then(operation); tail = result.catch(() => {}); return result;
  };
  const reset = async () => {
    if (!active.size) { clock = null; return; }
    try { await dispatch({ type: 'touchCancel', touchPoints: [] }); }
    finally { active.clear(); clock = null; }
  };
  const apply = async input => {
    const document = getDocument();
    const next = points(input), nextIds = new Set(next.map(p => p.id));
    if (input.type === 'touchCancel') {
      if (next.length) throw new Error('Invalid touch cancellation');
      return reset();
    }
    // Resize, parking or document replacement retires the old gesture. Late
    // moves/releases and an added finger cannot recreate that retired gesture.
    if (!active.size && (input.type !== 'touchStart' || next.length !== 1)) return;
    const added = next.filter(p => !active.has(p.id));
    const removed = [...active.values()].filter(p => !nextIds.has(p.id));
    if (input.type === 'touchStart' && (added.length !== 1 || removed.length)
      || input.type === 'touchMove' && (added.length || removed.length)
      || input.type === 'touchEnd' && (added.length || removed.length !== 1)) throw new Error('Invalid touch sequence');
    const touchPoints = input.type === 'touchStart' ? added : input.type === 'touchEnd' ? (next.length ? removed : []) : next;
    const modifiers = (Array.isArray(input.modifiers) ? input.modifiers : []).reduce((bits, modifier) => bits | ({ alt: 1, control: 2, meta: 4, shift: 8 }[modifier] ?? 0), 0);
    // Viewer time is a relative monotonic clock, never a trusted wall clock.
    // Start a gesture clock from capture age; genuine sample intervals survive
    // queue jitter, subject to causal, nondecreasing native time below.
    // Legacy senders remain untimed.
    const timed = active.size ? clock !== null : input.time !== undefined;
    const wall = now(), age = input.age ?? 0;
    if (!Number.isFinite(age) || age < 0 || age > 25000) throw new Error('Invalid touch age');
    // CDP translates Unix time using its current wall clock. Keep a small
    // margin for clock/IPC precision: a future event can crash Chromium's
    // compositor latency reporter even if it is only microseconds ahead.
    const causalNow = wall - 2;
    const nextClock = timed ? { ...(clock ?? { origin: input.time, native: causalNow - age, last: input.time, lastNative: -Infinity }) } : null;
    const history = input.history ?? [];
    if (!Array.isArray(history) || history.length >= MAX_TOUCH_SAMPLES
      || history.length && (input.type !== 'touchMove' || next.length !== 1 || !timed)) throw new Error('Invalid touch history');
    const samples = [];
    let timestamp;
    if (timed) {
      if (!Number.isFinite(input.time) || input.time < 0 || input.time > Number.MAX_SAFE_INTEGER
        || input.time < nextClock.last) throw new Error('Invalid touch time');
      let previous = nextClock.last;
      for (const sample of history) {
        const geometry = points({ type: 'touchMove', touchPoints: sample?.touchPoints });
        if (geometry.length !== 1 || geometry[0].id !== next[0].id) throw new Error('Invalid touch history');
        if (!Number.isFinite(sample.time) || sample.time < nextClock.origin || sample.time > input.time
          || input.time - sample.time > TOUCH_SAMPLE_WINDOW_MS) throw new Error('Invalid touch time');
        if (sample.time <= nextClock.last) continue;
        if (sample.time <= previous) throw new Error('Invalid touch time');
        previous = sample.time;
        const nativeTime = nextClock.native + sample.time - nextClock.origin;
        if (Math.abs(nativeTime - (causalNow - age)) > 25000) throw new Error('Invalid touch time');
        samples.push({ type: 'touchMove', touchPoints: geometry, modifiers, timestamp: nativeTime / 1000, sourceTime: sample.time });
      }
      const nativeTime = nextClock.native + input.time - nextClock.origin;
      // The original offset includes unknown transport delay. Validate a
      // bounded skew, not a future native timestamp, until it is normalized.
      if (Math.abs(nativeTime - (causalNow - age)) > 25000) throw new Error('Invalid touch time');
      // Falling network delay or clock drift can make a prior offset point
      // ahead of this arrival. Shift this batch back, preserving its genuine
      // sample intervals; never inject future or decreasing native time.
      nextClock.native -= Math.max(0, nativeTime - (causalNow - age));
      const floor = nextClock.lastNative;
      if (floor > causalNow) throw new Error('Touch clock changed');
      for (const sample of samples) sample.timestamp = (nextClock.native + sample.sourceTime - nextClock.origin) / 1000;
      timestamp = Math.max(floor, nextClock.native + input.time - nextClock.origin) / 1000;
      // Capture age and transport skew are separate bounds; they must not add
      // up to admitting an arbitrarily old native event after normalization.
      if ([timestamp, ...samples.map(sample => sample.timestamp)].some(time => time * 1000 < wall - 25002))
        throw new Error('Invalid touch time');
    }
    try {
      // A bounded real tail is available to restore native velocity after
      // coalescing. No old gesture replay, guessed velocity or wheel.
      const checkedDispatch = event => {
        if (document !== getDocument()) throw Object.assign(new Error('Browser document changed'), { code: 'DOCUMENT_CHANGED', retryable: true });
        return dispatch(event);
      };
      // Dense delivered samples already define native velocity. Only bridge a
      // coalescing gap that would reset Chromium's 40ms movement history, using
      // the newest genuine predecessor. Never replay every retained sample.
      if (timed && input.type === 'touchMove' && input.time - nextClock.last >= 40 && samples.length
        && samples.at(-1).timestamp * 1000 > nextClock.lastNative) {
        const { sourceTime, ...sample } = samples.at(-1);
        await checkedDispatch(sample);
      }
      const result = await checkedDispatch({ type: input.type, touchPoints, modifiers, ...(timed ? { timestamp } : {}) });
      active = new Map(next.map(p => [p.id, p]));
      clock = active.size && timed ? { ...nextClock, last: input.time, lastNative: timestamp * 1000 } : null;
      return result;
    } catch (error) {
      // A failed ACK may follow native acceptance. Do not leave contacts held
      // or retry a press into a different document.
      try { await dispatch({ type: 'touchCancel', touchPoints: [] }); } catch {}
      active.clear(); clock = null; throw error;
    }
  };
  const checkedApply = async input => {
    try { return await apply(input); }
    catch (error) { await reset().catch(() => {}); throw error; }
  };
  return {
    get active() { return active.size > 0; },
    apply: input => enqueue(() => checkedApply(input)),
    reset: () => enqueue(reset),
    mouse: event => enqueue(async () => {
      if (event.type === 'mouseDown') await reset();
      if (event.type !== 'mouseDown' && !active.size) return;
      return checkedApply({ type: event.type === 'mouseDown' ? 'touchStart' : event.type === 'mouseMove' ? 'touchMove' : 'touchEnd',
        touchPoints: event.type === 'mouseUp' ? [] : [{ id: 0, x: event.x, y: event.y }], modifiers: event.modifiers });
    }),
  };
}
// Explicit mouse/pen input wins over a mobile profile on hybrid devices.
function isTouchInput(input, profile) {
  return input.pointerType === 'touch' || input.pointerType === undefined
    && ['iphone','ipad','android-phone','android-tablet','desktop-touch'].includes(profile);
}
module.exports = { isTouchInput, createTouchInput, createWidgetTouchDispatcher, createWidgetWheelDispatcher, MAX_TOUCH_POINTS };
