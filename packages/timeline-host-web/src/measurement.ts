export function resizeObserverBlockSize(entry: ResizeObserverEntry): number {
  const borderBox = Array.isArray(entry.borderBoxSize)
    ? entry.borderBoxSize[0]
    : entry.borderBoxSize;
  const height = borderBox?.blockSize ?? entry.contentRect.height;
  return Number.isFinite(height) ? Math.max(0, height) : 0;
}

export function observeBorderBoxHeight(
  element: HTMLElement,
  onHeight: (heightPx: number) => void,
  invalidationTargets?: () => Iterable<Element>,
): () => void {
  // A retained view may be visually scaled inside a read-only overview card.
  // Measurements stay in its original layout coordinates, as ResizeObserver does.
  const preview = element.closest<HTMLElement>('[data-retained-preview-scale]');
  const scale = Number(preview?.dataset.retainedPreviewScale ?? 1);
  let heightPx = Math.max(0, element.getBoundingClientRect().height / (scale > 0 ? scale : 1));
  onHeight(heightPx);
  let disposed = false;
  const observed = new Set<Element>();
  const synchronizeTargets = () => {
    const targets = new Set<Element>([element, ...(invalidationTargets?.() ?? [])]);
    for (const target of observed) if (!targets.has(target)) { observer.unobserve(target); observed.delete(target); }
    for (const target of targets) if (!observed.has(target)) { observer.observe(target, { box: "border-box" }); observed.add(target); }
  };
  const observer = new ResizeObserver((records) => {
    if (disposed || !records.some(record => observed.has(record.target))) return;
    const record = records.find((candidate) => candidate.target === element);
    if (record !== undefined) heightPx = resizeObserverBlockSize(record);
    // A painted child can resize while the whole footer keeps the same height
    // (for example a floating summary is replaced by an attached queue). It
    // invalidates paint geometry, never the footer's measured reservation.
    onHeight(heightPx);
    if (!disposed) synchronizeTargets();
  });
  synchronizeTargets();
  return () => { disposed = true; observer.disconnect(); observed.clear(); };
}
