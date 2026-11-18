export interface RetainedScrollPosition { node: HTMLElement; top: number; left: number; followEnd: boolean }
function readPositions(positions: RetainedScrollPosition[]) {
  return positions.map(value => ({ ...value,
    top: value.followEnd ? value.node.scrollHeight-value.node.clientHeight : value.top }));
}
function writePositions(positions: RetainedScrollPosition[]) {
  for (const { node, top, left } of positions) { node.scrollTop = top; node.scrollLeft = left; }
}
export function restoreRetainedScroll(positions: RetainedScrollPosition[]) { writePositions(readPositions(positions)); }

// Handback is a multi-root transaction. Read once after all roots have reached
// their final home layout, then write all scroll positions before the next paint.
// No timer/frame delay and no repeated write-layout-read cycle for each root.
const pending = new Map<HTMLElement, RetainedScrollPosition[]>();
let scheduled = false;
export function cancelRetainedScrollRestore(root: HTMLElement) { const positions = pending.get(root); pending.delete(root); return positions; }
export function queueRetainedScrollRestore(root: HTMLElement, positions: RetainedScrollPosition[]) {
  pending.set(root, positions);
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(function flushRetainedScroll() {
    scheduled = false;
    const all = [...pending].filter(([owner]) => owner.isConnected).flatMap(([, values]) => values);
    pending.clear();
    restoreRetainedScroll(all);
  });
}
