/** Pure presentation math: never interpolate page geometry or guess element identity. */
export type Box = { x: number; y: number; width: number; height: number };
export function placeAnnotationCard(viewport: { width: number; height: number }, size: { width: number; height: number }, target: Box | null, toolbarBottom: number, gap = 12): Box {
  const width = Math.min(size.width, Math.max(0, viewport.width - gap * 2));
  const top = Math.min(Math.max(gap, toolbarBottom + gap), Math.max(gap, viewport.height - 100));
  const height = Math.min(size.height, Math.max(0, viewport.height - top - gap));
  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, Math.max(min, max)));
  const fit = (x: number, y: number) => ({ x: clamp(x, gap, viewport.width - width - gap), y: clamp(y, top, viewport.height - height - gap), width, height });
  if (!target) return fit((viewport.width - width) / 2, viewport.height - height - gap);
  const positions = [fit(target.x + target.width + gap, target.y), fit(target.x - width - gap, target.y), fit(target.x, target.y + target.height + gap), fit(target.x, target.y - height - gap), fit(viewport.width - width - gap, viewport.height - height - gap), fit(gap, top)];
  const overlap = (b: Box) => Math.max(0, Math.min(b.x + b.width, target.x + target.width) - Math.max(b.x, target.x)) * Math.max(0, Math.min(b.y + b.height, target.y + target.height) - Math.max(b.y, target.y));
  return positions.reduce((best, box) => overlap(box) < overlap(best) ? box : best);
}
export function parseStyleNumber(value: string): { value: number; unit: string } | null {
  const match = /^(-?(?:\d+(?:\.\d*)?|\.\d+))(px|rem|em|%|vh|vw)?$/.exec(value.trim());
  return match && Number.isFinite(Number(match[1])) ? { value: Number(match[1]), unit: match[2] ?? "" } : null;
}
export function stepStyleNumber(value: string, delta: number, min = 0): string | null {
  const parsed = parseStyleNumber(value); if (!parsed || !Number.isFinite(delta)) return null;
  const step = parsed.unit === "rem" || parsed.unit === "em" || !parsed.unit && parsed.value < 4 ? .1 : 1;
  const next = Math.max(min, Math.min(100000, Math.round((parsed.value + delta * step) * 1000) / 1000));
  return `${next}${parsed.unit}`;
}
export function ratioStyleValue(value: string, previous: string, paired: string): string | null {
  const a = parseStyleNumber(value), b = parseStyleNumber(previous), c = parseStyleNumber(paired);
  if (!a || !b || !c || b.value <= 0 || c.value <= 0 || a.unit !== b.unit || b.unit !== c.unit || !["px", "rem", "em"].includes(a.unit)) return null;
  return `${Math.round(c.value * a.value / b.value * 1000) / 1000}${c.unit}`;
}
