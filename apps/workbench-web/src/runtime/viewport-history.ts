import { isLocalDiagnosticsEnabled, subscribeLocalDiagnostics } from "./local-diagnostics";
export const VIEWPORT_HISTORY_LIMIT = 240;
export interface ViewportDiagnosticSample {
  readonly at: number;
  readonly event: string;
  readonly geometry: Readonly<Record<string, number>>;
}

const history: ViewportDiagnosticSample[] = [];
const sizes: number[] = [];
let bytes = 0;
export function clearViewportHistory(): void {
  history.length = 0; sizes.length = 0; bytes = 0; lastEditing = lastReducedEditing = null;
}
subscribeLocalDiagnostics(() => { if (isLocalDiagnosticsEnabled()) clearViewportHistory(); });
let lastEditing: ViewportDiagnosticSample | null = null;
let lastReducedEditing: ViewportDiagnosticSample | null = null;

/** Local evidence shares the viewport owner's bounded observation cadence. */
export function recordViewportDiagnostic(geometry: Readonly<Record<string, number>>, event = "observation"): void {
  if (!isLocalDiagnosticsEnabled()) return;
  const sample = { at: Date.now(), event, geometry: Object.fromEntries(Object.entries(geometry).slice(0, 96)) };
  const size = new TextEncoder().encode(JSON.stringify(sample)).length;
  history.push(sample); sizes.push(size); bytes += size;
  while (history.length > VIEWPORT_HISTORY_LIMIT || bytes > 160 * 1024) { history.shift(); bytes -= sizes.shift()!; }
  if (geometry.editing === 1) lastEditing = sample;
  if (geometry.editing === 1 && geometry.scale === 1 && (geometry.visualHeight ?? 0) > 0
    && (geometry.visualHeight ?? 0) < (geometry.clientHeight ?? 0)) lastReducedEditing = sample;
}

export function captureViewportHistory() {
  const copy = (sample: ViewportDiagnosticSample) => ({ ...sample, geometry: { ...sample.geometry } });
  return { limit: VIEWPORT_HISTORY_LIMIT, samples: history.map(copy), lastEditing: lastEditing ? copy(lastEditing) : null,
    lastReducedEditing: lastReducedEditing ? copy(lastReducedEditing) : null };
}
