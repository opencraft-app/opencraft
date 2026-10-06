/** Keep every row on the same columns while allowing the table to scroll locally. */
export function nativeTableColumnWidth(viewportWidth: number, columnCount: number): number {
  const count = Math.max(1, Math.floor(columnCount));
  return Math.max(132, (viewportWidth > 0 ? viewportWidth : count * 160) / count);
}
