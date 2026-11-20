/** Always-on, bounded device-local queue failures. Never upload or store raw errors/input. */
const KEY = "opencraft.queueErrors.v1";
const LIMIT = 100, BYTES = 64 * 1024, TTL = 7 * 24 * 60 * 60 * 1000;
type Fields = Readonly<Record<string, string | number | boolean | null>>;
type Entry = { at: number; kind: "queue-operation-failed"; fields: Fields };
const allowed = new Set(["action", "hostId", "threadId", "queueId", "rpcCode", "reason", "retryable", "notSubmitted", "submissionOutcome"]);
function sanitize(fields: Fields): Fields {
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) => allowed.has(key) &&
    (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)))
    .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 160) : value]));
}
export function createQueueErrorHistory(storage: () => Pick<Storage, "getItem" | "setItem"> | undefined,
  now: () => number = Date.now) {
  let entries: Entry[] = [];
  let loaded = false;
  let persisted = false;
  const trim = () => {
    entries = entries.filter(entry => Number.isFinite(entry.at) && entry.at >= now() - TTL && entry.at <= now()).slice(-LIMIT);
    while (entries.length && new TextEncoder().encode(JSON.stringify(entries)).length > BYTES) entries.shift();
  };
  const load = () => {
    if (loaded) return;
    loaded = true;
    try {
      const raw = storage()?.getItem(KEY);
      if (raw && raw.length <= BYTES) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) entries = parsed.filter(e => e && typeof e.at === "number" && e.kind === "queue-operation-failed" && e.fields && typeof e.fields === "object" && !Array.isArray(e.fields))
          .slice(-LIMIT).map(e => ({ at: e.at, kind: "queue-operation-failed", fields: sanitize(e.fields) }));
        persisted = true;
      }
    } catch { /* Storage restrictions/corruption cannot interrupt messaging. */ }
    trim();
  };
  const save = () => {
    try { const target = storage(); persisted = !!target; target?.setItem(KEY, JSON.stringify(entries)); }
    catch { persisted = false; }
  };
  return {
    record(fields: Fields) { load(); entries.push({ at: now(), kind: "queue-operation-failed", fields: sanitize(fields) }); trim(); save(); },
    capture() { load(); trim(); save(); return { enabled: true, persisted, upload: false, limit: LIMIT, byteLimit: BYTES, retentionDays: 7,
      samples: entries.map(entry => ({ ...entry, fields: { ...entry.fields } })) }; },
  };
}
const history = createQueueErrorHistory(() => typeof window === "undefined" ? undefined : window.localStorage);
export const recordQueueError = history.record;
export const captureQueueErrors = history.capture;
