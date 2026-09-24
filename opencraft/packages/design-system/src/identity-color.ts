/** Stable identity color. It communicates sameness only, never status. */
export function stableIdentityColor(identity: string): string {
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  // Avalanche similar prefixes before choosing a hue. Host IDs frequently
  // share provider prefixes, and nearby hues would fail their identity role.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  const hue = Math.abs(hash >>> 0) % 360;
  return `light-dark(oklch(58% 0.18 ${hue}), oklch(76% 0.14 ${hue}))`;
}
