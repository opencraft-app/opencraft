import type { BrowserViewportLayout } from "@opencraft/browser-core";

/** Clip the backing without changing its layout viewport or input coordinates. */
export function browserPresentationClipPath({ visualBounds: b, stageBounds: s }: BrowserViewportLayout): string {
  const clamp = (value: number, maximum: number) => Math.max(0, Math.min(maximum, value));
  const top = clamp(s.y - b.y, b.height), left = clamp(s.x - b.x, b.width);
  const right = clamp(b.x + b.width - s.x - s.width, b.width);
  const bottom = clamp(b.y + b.height - s.y - s.height, b.height);
  return `inset(${top}px ${right}px ${bottom}px ${left}px)`;
}
