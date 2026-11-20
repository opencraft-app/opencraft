/** Optional, read-only observations: never owns layout or scroll writes. */
export type TimelineDiagnosticFields = Readonly<Record<string, string | number | boolean | null>>;
type Observer = (kind: string, fields: TimelineDiagnosticFields) => void;
let observer: Observer | undefined;
const enabledListeners = new Set<() => void>();
export function setTimelineDiagnosticObserver(next: Observer | undefined): void {
  const changed = (observer === undefined) !== (next === undefined);
  observer = next;
  if (changed) for (const listener of enabledListeners) {
    try { listener(); } catch { /* Diagnostics cannot affect the viewport. */ }
  }
}
export function subscribeTimelineDiagnostics(listener: () => void): () => void {
  enabledListeners.add(listener);
  return () => { enabledListeners.delete(listener); };
}
/** Keep the frame sampler out of the normal startup graph as well as the hot
 * path. Disabling or retiring a viewport revokes even a pending module load. */
export function observeTimelineScrollFrames(root: HTMLDivElement, owner: object, isCurrent: () => boolean): () => void {
  let disposed = false, generation = 0;
  let stop: (() => void) | undefined;
  const update = () => {
    const lease = ++generation;
    stop?.(); stop = undefined;
    if (!timelineDiagnosticsEnabled()) return;
    void import("./scroll-frame-diagnostics").then(({ observeWebScrollFrames }) => {
      if (disposed || generation !== lease || !timelineDiagnosticsEnabled() || !isCurrent()) return;
      stop = observeWebScrollFrames(root, owner, isCurrent);
    }).catch(() => { /* Optional diagnostics must not interrupt the viewport. */ });
  };
  const unsubscribe = subscribeTimelineDiagnostics(update);
  update();
  return () => { disposed = true; generation++; unsubscribe(); stop?.(); };
}
export function timelineDiagnosticsEnabled(): boolean { return observer !== undefined; }
export function recordTimelineDiagnostic(kind: string, fields: TimelineDiagnosticFields): void {
  try { observer?.(kind, fields); } catch { /* Observations cannot change scrolling. */ }
}
// Correlate rows and viewports without retaining DOM or exporting conversation IDs.
let sequence = 0;
const elements = new WeakMap<object, number>();
export function timelineDiagnosticId(element: object): number {
  let id = elements.get(element);
  if (id === undefined) { id = ++sequence; elements.set(element, id); }
  return id;
}
