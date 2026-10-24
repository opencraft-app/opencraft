/** Deliberately closed telemetry vocabulary. Never serialize business payloads. */
export const schemaVersion = 1;
export const limits = Object.freeze({ eventBytes: 2048, batchEvents: 32, batchBytes: 32768,
  queueEvents: 2048, queueBytes: 2097152, recentEvents: 128, recentBytes: 131072,
  clientQueueBytes: 262144, rows: 500, responseBytes: 1048576, concurrency: 5,
  freshnessMs: 90000, retentionMs: 604800000, maxWindowMs: 86400000 });
export const kinds = ['producer', 'operation', 'rpc', 'recovery', 'execution', 'queue', 'dependency', 'resource', 'client_signal'];
export const operations = ['navigation', 'thread_open', 'catalog_first', 'catalog_complete', 'configuration_confirmed', 'submit_ready', 'preference_save', 'recovery', 'other'];
export const outcomes = ['started', 'progress', 'ok', 'failed', 'timeout', 'aborted', 'unfinished', 'unknown'];
export const stages = ['connecting', 'initializing', 'backoff', 'blocked', 'queued', 'history', 'ready', 'model', 'tool', 'human', 'capacity', 'running', 'completed', 'failed', 'other'];
export const methods = ['initialize','runtime/machine/read','thread/read','thread/resume','thread/list','thread/start','thread/fork','thread/unsubscribe','thread/archive','thread/name/set','thread/items/list','thread/turns/list','thread/loaded/list','turn/start','turn/steer','turn/interrupt','turn/continue','turn/respond','model/list','config/read','config/value/write','config/batchWrite','configRequirements/read','tasks/list','tasks/read','tasks/create','tasks/update','tasks/delete','opencraft/tasks/list','opencraft/tasks/read','opencraft/tasks/create','opencraft/tasks/update','opencraft/schedules/list','opencraft/schedules/create','opencraft/schedules/update','opencraft/schedules/delete','fs/read','fs/write','fs/stat','fs/list','fuzzyFileSearch','command/exec','command/exec/write','command/exec/terminate','process/spawn','process/kill','process/writeStdin','skills/list','skills/read','bot/list','bot/read','mcpServerStatus/list','other'];
export const components = ['web', 'gateway', 'core', 'codex', 'dsh', 'pi', 'observe', 'collector', 'prometheus', 'loki', 'grafana'];
export const origins = ['interactive', 'automation', 'operator', 'probe', 'unknown'];
const id = /^[a-zA-Z0-9_.:-]{1,128}$/u;
const revision = /^[a-zA-Z0-9_.:+-]{1,128}$/u;
const ids = ['eventId', 'producerId', 'attemptId', 'operationId', 'executionId', 'recoveryId', 'requestId', 'incidentRef', 'pairId'];
const enums = { kind: kinds, component: components, operationType: operations, outcome: outcomes,
  stage: stages, method: methods, originClass: origins, actorKind: ['human','agent','session','unknown'],
  measurementScope: ['navigation','in_page','rpc','domain','process','client'],
  observedBy: ['self','gateway'], identitySource: ['self','health','installed_artifact','installed_manifest','unknown'], producerMode: ['native','health_projection','client'],
  cache: ['cold','warm','unknown'], visibility: ['visible','hidden','unknown'], engine: ['codex','dsh','pi','none','unknown'] };
/** Unknown keys are discarded; malformed known keys reject only this record. */
export function sanitizeEvent(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== schemaVersion) return null;
  if (!kinds.includes(input.kind) || !components.includes(input.component)) return null;
  const event = { schemaVersion };
  for (const [key, choices] of Object.entries(enums)) if (input[key] !== undefined) {
    if (!choices.includes(input[key])) return null;
    event[key] = input[key];
  }
  for (const key of ids) if (input[key] !== undefined) {
    if (typeof input[key] !== 'string' || !id.test(input[key])) return null;
    event[key] = input[key];
  }
  if (!event.eventId || !event.producerId) return null;
  for (const key of ['generation','attempt','count','bytes','dropped','rejected','durationMs','rssBytes','heapBytes','cpuSeconds','eventLoopDelayMs']) if (input[key] !== undefined) {
    if (!Number.isFinite(input[key]) || input[key] < 0 || input[key] > Number.MAX_SAFE_INTEGER) return null;
    event[key] = input[key];
  }
  for (const key of ['sourceRevision','buildId','version','workloadDigest']) if (input[key] !== undefined) {
    if (input[key] === null) { event[key] = null; continue; }
    if (typeof input[key] !== 'string' || !revision.test(input[key])) return null;
    event[key] = input[key];
  }
  if (!Number.isFinite(input.at) || (input.at > now + 30000 || now - input.at > limits.retentionMs)) return null;
  event.at = input.at;
  event.originClass ??= 'unknown'; event.actorKind ??= 'unknown';
  return new TextEncoder().encode(JSON.stringify(event)).length <= limits.eventBytes ? event : null;
}
export function fault(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
export function windowFor(input = {}, now = Date.now(), max = limits.maxWindowMs) {
  const to = input.to === undefined ? now : Date.parse(input.to);
  const from = input.from === undefined ? to - 900000 : Date.parse(input.from);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > max || to > now + 30000) throw fault('invalid_window');
  return { from, to };
}
