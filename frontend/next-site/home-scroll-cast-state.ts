/** Pure choreography: all progress comes from section-relative ScrollTriggers. */
// Match the approved peek-friends artwork; keep its palette, shape and accessory identity.
export const CAST = [
  { name: 'lilac', color: '#D4C9EB', shape: 'bean', accessory: 'headphones-record', side: -1, order: 0, delay: .20 },
  { name: 'peach', color: '#EDCBD3', shape: 'round', accessory: 'wizard-cape', side: -1, order: 1, delay: .08 },
  { name: 'mint', color: '#CFE3DB', shape: 'square', accessory: 'bucket-book', side: -1, order: 2, delay: .15 },
  { name: 'sky', color: '#C8DEF0', shape: 'drop', accessory: 'star-glasses', side: -1, order: 3, delay: 0 },
  { name: 'butter', color: '#F1E5CD', shape: 'cloud', accessory: 'goggles-scarf', side: 1, order: 0, delay: .12 },
  { name: 'coral', color: '#EDCBD3', shape: 'round', accessory: 'beret-camera', side: 1, order: 1, delay: .04 },
  { name: 'periwinkle', color: '#D4C9EB', shape: 'bean', accessory: 'knit-beanie', side: 1, order: 2, delay: .18 },
] as const;
export type CastMember = typeof CAST[number];
export const clamp = (value: number) => Math.min(1, Math.max(0, value));
export const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
export function heroPose(progress: number, delay: number) {
  const p = clamp((progress - delay) / (1 - delay));
  return { release: smooth(p / .32), fall: Math.pow(p, 1.65), visible: p < 1 };
}
export function castVisible(index: number, mobile: boolean, atVoice: boolean) {
  return (mobile ? [] : atVoice ? [0, 1] : [0, 1, 2, 3]).includes(index);
}
