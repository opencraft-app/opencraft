"use strict";
// A bounded tail of real samples, not synthetic velocity or predicted movement.
const MAX_TOUCH_SAMPLES = 3;
const TOUCH_SAMPLE_WINDOW_MS = 48;
function mergeTouchMoves(previous, next) {
  if (previous.touchPoints?.length !== 1 || next.touchPoints?.length !== 1
    || previous.touchPoints[0]?.id !== next.touchPoints[0]?.id
    || [previous, next].some(input => input.history !== undefined && (!Array.isArray(input.history) || input.history.length >= MAX_TOUCH_SAMPLES))
    || previous.type !== 'touchMove' || next.type !== 'touchMove'
    || !Number.isFinite(previous.time) || !Number.isFinite(next.time) || next.time < previous.time) return next;
  const sample = input => ({ time: input.time, touchPoints: input.touchPoints });
  const candidates = [...(previous.history ?? []), sample(previous), ...(next.history ?? [])];
  const history = [];
  for (const point of candidates) {
    if (!point || !Number.isFinite(point.time) || point.time >= next.time || next.time - point.time > TOUCH_SAMPLE_WINDOW_MS) continue;
    if (history.length && point.time <= history[history.length - 1].time) continue;
    history.push(point);
  }
  return { ...next, history: history.slice(-(MAX_TOUCH_SAMPLES - 1)) };
}
module.exports = { mergeTouchMoves, MAX_TOUCH_SAMPLES, TOUCH_SAMPLE_WINDOW_MS };
