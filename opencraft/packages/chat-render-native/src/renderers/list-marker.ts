export function nativeListMarker(ordered: boolean, start: number | null, index: number, depth = 0): string {
  if (ordered) return `${(start ?? 1) + index}.`;
  return depth <= 0 ? "•" : depth === 1 ? "◦" : "▪";
}

/** Keep every item body aligned when ordered markers cross a digit boundary. */
export function nativeListMarkerColumnWidth(ordered: boolean, start: number | null, count: number): number {
  if (!ordered) return 18;
  const first = start ?? 1;
  const last = first + Math.max(0, count - 1);
  return Math.max(18, (Math.max(String(first).length, String(last).length) + 1) * 8);
}
