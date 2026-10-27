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
): () => void {
  onHeight(Math.max(0, element.getBoundingClientRect().height));
  const observer = new ResizeObserver((records) => {
    const record = records.find((candidate) => candidate.target === element);
    if (record !== undefined) onHeight(resizeObserverBlockSize(record));
  });
  observer.observe(element, { box: "border-box" });
  return () => observer.disconnect();
}
