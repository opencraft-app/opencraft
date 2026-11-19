import { captureQueueErrors } from "./queue-error-history";
/** Device-local opt-in. Only the preference persists; evidence stays in this page. */
export const LOCAL_DIAGNOSTICS_KEY = "opencraft.localDiagnostics.enabled";
export const LOCAL_DIAGNOSTICS_LIMIT = 600;
export const LOCAL_DIAGNOSTICS_BYTES = 384 * 1024;
export const LOCAL_DIAGNOSTICS_FRAME_LIMIT = 240;
export const LOCAL_DIAGNOSTICS_FRAME_BYTES = 128 * 1024;
type Fields = Readonly<Record<string, string | number | boolean | null>>;
interface Sample {
  readonly at: number;
  readonly kind: string;
  readonly fields: Fields;
}
function readPreference(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(LOCAL_DIAGNOSTICS_KEY) === "true";
  } catch {
    return false;
  }
}
let state = {
  enabled: readPreference(),
  enabledSince: null as number | null,
  stoppedAt: null as number | null,
  session: 0,
};
if (state.enabled) {
  state.enabledSince = Date.now();
  state.session++;
}
const listeners = new Set<() => void>();
const history: { sample: Sample; bytes: number }[] = [];
let bytes = 0,
  evicted = 0;
// Reserve a bounded frame partition so per-frame evidence cannot flood out
// measurement/scroll-write events. Both partitions share the original byte cap.
const frames: { sample: Sample; bytes: number }[] = [];
let frameBytes = 0,
  frameEvicted = 0;
export const getLocalDiagnosticsState = () => state;
export const isLocalDiagnosticsEnabled = () => state.enabled;
export function subscribeLocalDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function setLocalDiagnosticsEnabled(enabled: boolean): void {
  if (enabled === state.enabled) return;
  // Keep the session usable even when the browser denies persistent storage.
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(LOCAL_DIAGNOSTICS_KEY, String(enabled));
  } catch {
    /* page-only opt-in */
  }
  if (enabled) {
    history.length = 0;
    bytes = 0;
    evicted = 0;
    frames.length = 0;
    frameBytes = 0;
    frameEvicted = 0;
  }
  state = {
    enabled,
    enabledSince: enabled ? Date.now() : state.enabledSince,
    stoppedAt: enabled ? null : Date.now(),
    session: state.session + 1,
  };
  for (const listener of listeners) listener();
}
export function recordLocalDiagnostic(kind: string, fields: Fields): void {
  if (!state.enabled) return;
  const safe = Object.fromEntries(
    Object.entries(fields)
      .slice(0, 32)
      .map(([key, value]) => [key.slice(0, 64), typeof value === "string" ? value.slice(0, 512) : value]),
  );
  const sample: Sample = { at: Date.now(), kind: kind.slice(0, 64), fields: safe };
  const size = new TextEncoder().encode(JSON.stringify(sample)).length;
  if (size > 8192) return;
  if (kind === "scroll-frame") {
    frames.push({ sample, bytes: size });
    frameBytes += size;
    while (frames.length > LOCAL_DIAGNOSTICS_FRAME_LIMIT || frameBytes > LOCAL_DIAGNOSTICS_FRAME_BYTES) {
      frameBytes -= frames.shift()!.bytes;
      frameEvicted++;
    }
    return;
  }
  history.push({ sample, bytes: size });
  bytes += size;
  while (history.length > LOCAL_DIAGNOSTICS_LIMIT || bytes > LOCAL_DIAGNOSTICS_BYTES - LOCAL_DIAGNOSTICS_FRAME_BYTES) {
    bytes -= history.shift()!.bytes;
    evicted++;
  }
}
export function captureLocalDiagnostics() {
  return {
    errors: captureQueueErrors(),
    ...state,
    storage: "memory",
    upload: false,
    limit: LOCAL_DIAGNOSTICS_LIMIT,
    byteLimit: LOCAL_DIAGNOSTICS_BYTES,
    bytes: bytes + frameBytes,
    evicted: evicted + frameEvicted,
    samples: history.map(({ sample }) => ({ ...sample, fields: { ...sample.fields } })),
    frames: {
      limit: LOCAL_DIAGNOSTICS_FRAME_LIMIT,
      byteLimit: LOCAL_DIAGNOSTICS_FRAME_BYTES,
      bytes: frameBytes,
      evicted: frameEvicted,
      samples: frames.map(({ sample }) => ({ ...sample, fields: { ...sample.fields } })),
    },
  };
}
