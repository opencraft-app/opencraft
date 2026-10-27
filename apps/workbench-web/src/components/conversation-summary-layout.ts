/** Budget the real reading plane before reserving room for its inspector. */
export function resolveSummaryPresentation(available: number, reading: number, panelSpace: number): "overlay" | "shift" | "gutter" {
  if (![available, reading, panelSpace].every(value => Number.isFinite(value) && value > 0)) return "overlay";
  if (available < reading + panelSpace) return "overlay";
  return available - reading >= panelSpace * 2 ? "gutter" : "shift";
}
