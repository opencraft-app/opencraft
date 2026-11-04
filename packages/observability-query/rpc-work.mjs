/** Work origin and timing layer are independent. Never count child spans as RPCs. */
export function rpcWorkClass(event) {
  if (!event || !['rpc', 'dependency'].includes(event.kind)) return 'unknown';
  if (event.component === 'web' && event.kind === 'rpc') return 'foreground';
  if (event.component !== 'gateway') return 'unknown';
  if (event.caller === 'server-refresh' || event.traceRole === 'background-refresh') return 'background';
  if (event.kind === 'rpc' || ['sidebar-catalog', 'thread-catalog', 'history', 'client'].includes(event.caller)) return 'foreground';
  return 'unknown';
}
const quantile = (values, p) => values[Math.max(0, Math.ceil(values.length * p) - 1)];
/** Groups preserve component/stage/role so background roots and native/storage
 * children remain separately visible. Historical caller/traceRole work too. */
export function rpcLatencySummary(events) {
  const groups = new Map();
  for (const event of events ?? []) {
    if (!['rpc', 'dependency'].includes(event?.kind) || event.measurementScope !== 'rpc'
      || !Number.isFinite(event.durationMs) || event.durationMs < 0) continue;
    const dimensions = { workClass: rpcWorkClass(event), kind: event.kind,
      component: event.component ?? 'unknown', stage: event.stage ?? '', traceRole: event.traceRole ?? 'unknown' };
    const key = JSON.stringify(dimensions);
    if (!groups.has(key)) groups.set(key, { dimensions, values: [] });
    groups.get(key).values.push(event.durationMs);
  }
  return [...groups.values()].map(({ dimensions, values }) => {
    values.sort((a, b) => a - b);
    return { ...dimensions, count: values.length, p50Ms: quantile(values, .5), p95Ms: quantile(values, .95),
      p99Ms: quantile(values, .99), maxMs: values.at(-1), over1s: values.filter(v => v >= 1000).length };
  });
}
/** Compact fixed-vocabulary completion log. Full telemetry keeps its existing
 * caller/traceRole contract; old Observe installations need no schema upgrade. */
export function backgroundRefreshLog(event) {
  if (rpcWorkClass(event) !== 'background' || event.traceRole !== 'background-refresh'
    || !Number.isFinite(event.durationMs) || event.durationMs < 0
    || event.durationMs < 1000 && event.outcome === 'ok') return null;
  const result = { workClass: 'background', kind: 'dependency', traceRole: 'background-refresh',
    method: ['thread/list', 'thread/read'].includes(event.method) ? event.method : 'other',
    outcome: ['ok', 'failed', 'aborted', 'timeout'].includes(event.outcome) ? event.outcome : 'unknown',
    durationMs: event.durationMs };
  if (['initial-discovery', 'cached-head', 'watched-read', 'repair'].includes(event.refreshReason)) result.refreshReason = event.refreshReason;
  for (const key of ['directoryPages', 'gatewaySourceMs', 'gatewayStorageMs', 'storageQueueMs'])
    if (Number.isFinite(event[key]) && event[key] >= 0) result[key] = event[key];
  if (event.directoryRestart === 'source-invalidated') result.directoryRestart = event.directoryRestart;
  for (const [key, length] of [['traceId', 32], ['spanId', 16], ['linkedTraceId', 32], ['linkedSpanId', 16]])
    if (typeof event[key] === 'string' && new RegExp(`^[0-9a-f]{${length}}$`, 'u').test(event[key])) result[key] = event[key];
  return result;
}
