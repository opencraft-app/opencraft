'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { HermesDrawingLayer } from '@/components/site/hermes-drawing-layer';
import type { HermesAppearance, HermesDoodleShape, HermesSkin } from '@/lib/hermes-appearance';
import { cn } from '@/lib/utils';

export const PLUSH_ROOT = '/assets/mascot-dressup/plush';
export const PLUSH_OUTFITS = {
  headphones: 'headphones', 'wizard-hat': 'wizard-hat', 'bucket-hat': 'bucket-hat',
  'star-glasses': 'star-glasses', goggles: 'goggles', beret: 'beret', beanie: 'beanie',
  cape: 'cape', scarf: 'scarf', record: 'record', book: 'book', camera: 'camera',
} as const;

const BASE_HUE: Record<HermesDoodleShape, number> = { bean: 263, round: 355, square: 160, drop: 215, cloud: 43 };
const SKIN_HUE: Partial<Record<HermesSkin, number>> = { lavender: 263, peach: 355, butter: 43, mint: 160, sky: 215 };

function bodyFilter(shape: HermesDoodleShape, skin: HermesSkin) {
  if (skin === 'charcoal') return 'grayscale(1) brightness(.51)';
  if (skin === 'white') return 'saturate(.16) brightness(1.08)';
  const difference = (SKIN_HUE[skin] ?? BASE_HUE[shape]) - BASE_HUE[shape];
  return difference ? `hue-rotate(${difference}deg)` : undefined;
}

// All layers use the same frontal canvas; changing accessories never swaps the body.
// The five shapes are not geometrically identical (head width, eye line and body
// width all differ), so an accessory must be anchored per shape instead of at one
// fixed percentage. These anchors are measured from each front-*.webp sprite and
// mirror the per-shape FIT table in hermes-doodle-avatar.tsx.
type PlushAnchor = { headL: number; headR: number; bodyL: number; bodyR: number; eyeY: number; bottom: number };
const PLUSH_ANCHORS: Record<HermesDoodleShape, PlushAnchor> = {
  round: { headL: .31, headR: .69, bodyL: .24, bodyR: .75, eyeY: .552, bottom: .926 },
  bean: { headL: .34, headR: .66, bodyL: .29, bodyR: .71, eyeY: .549, bottom: .932 },
  square: { headL: .27, headR: .73, bodyL: .24, bodyR: .76, eyeY: .553, bottom: .928 },
  drop: { headL: .37, headR: .63, bodyL: .27, bodyR: .73, eyeY: .587, bottom: .930 },
  cloud: { headL: .34, headR: .65, bodyL: .19, bodyR: .80, eyeY: .553, bottom: .926 },
};

type PlushSlot = 'head' | 'eyes' | 'ears' | 'neck' | 'hold';
// aspect is the accessory sprite's real height/width; width scales it against the
// head or body anchor, and dy nudges it vertically within its slot.
const PLUSH_FIT: Record<keyof typeof PLUSH_OUTFITS, { slot: PlushSlot; aspect: number; width: number; dy: number }> = {
  'wizard-hat': { slot: 'head', aspect: .831, width: 1.00, dy: -.015 },
  'bucket-hat': { slot: 'head', aspect: .602, width: 1.15, dy: -.012 },
  beret: { slot: 'head', aspect: .576, width: .95, dy: -.01 },
  beanie: { slot: 'head', aspect: .776, width: 1.05, dy: -.01 },
  'star-glasses': { slot: 'eyes', aspect: .471, width: 1.00, dy: 0 },
  goggles: { slot: 'eyes', aspect: .552, width: 1.06, dy: 0 },
  headphones: { slot: 'ears', aspect: .801, width: 1.30, dy: 0 },
  cape: { slot: 'neck', aspect: .432, width: 1.00, dy: 0 },
  scarf: { slot: 'neck', aspect: .616, width: .65, dy: .01 },
  record: { slot: 'hold', aspect: .651, width: .50, dy: 0 },
  book: { slot: 'hold', aspect: .913, width: .42, dy: 0 },
  camera: { slot: 'hold', aspect: .622, width: .55, dy: 0 },
};

const pct = (value: number) => `${(value * 100).toFixed(2)}%`;

function placementFor(shape: HermesDoodleShape, id: keyof typeof PLUSH_OUTFITS): React.CSSProperties {
  const a = PLUSH_ANCHORS[shape];
  const fit = PLUSH_FIT[id];
  const headWidth = a.headR - a.headL;
  const bodyWidth = a.bodyR - a.bodyL;
  let width: number;
  let top: number;
  switch (fit.slot) {
    case 'head':
      // Hats sit on the forehead: their brim ends just above the eye line.
      width = headWidth * fit.width;
      top = a.eyeY - 0.055 - width * fit.aspect + fit.dy;
      break;
    case 'eyes':
      // Glasses centre on the eye line.
      width = headWidth * fit.width;
      top = a.eyeY - (width * fit.aspect) / 2 + fit.dy;
      break;
    case 'ears':
      // Headphones wrap the head, wider than it and centred on the eye line.
      width = headWidth * fit.width;
      top = a.eyeY - (width * fit.aspect) / 2 + fit.dy;
      break;
    case 'neck':
      // Cape / scarf hang from the neck, just below the eye line.
      width = bodyWidth * fit.width;
      top = a.eyeY + 0.05 + fit.dy;
      break;
    case 'hold':
    default:
      // Held props rest on the lower body, centred between the eyes and the feet.
      width = bodyWidth * fit.width;
      top = (a.eyeY + a.bottom) / 2 - (width * fit.aspect) / 2 + fit.dy;
      break;
  }
  return {
    left: pct(0.5 - width / 2),
    top: pct(top),
    width: pct(width),
    height: pct(width * fit.aspect),
  };
}

export function HermesPlushAvatar({ appearance, size = 96, alive = false, reaction = 0, className }: {
  appearance: HermesAppearance; size?: number; alive?: boolean; reaction?: number; className?: string;
}) {
  const shape = appearance.shape ?? 'bean';
  const parts = appearance.doodads ?? [];
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false));
    observer.observe(ref.current);
    const update = () => setPageVisible(!document.hidden);
    update(); document.addEventListener('visibilitychange', update);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, []);
  const moving = alive && visible && pageVisible && !reduced;
  return <motion.div ref={ref} role="img" aria-label="Hermes" data-testid="dressup-preview" data-style="doodle" data-shape={shape}
    className={cn('relative shrink-0 select-none', className)} style={{ width: size, height: size }}
    animate={{ y: moving ? [0, -3, 0] : 0 }} transition={moving ? { duration: 4, repeat: Infinity, ease: 'easeInOut' } : { duration: 0 }}>
    <motion.div key={`${shape}-${reaction}`} className="absolute inset-0" initial={alive && !reduced ? { scale: .97, rotate: -1.5 } : false}
      animate={{ scale: 1, rotate: 0 }} transition={{ duration: .18 }}>
      <img src={`${PLUSH_ROOT}/front-${shape}.webp`} alt="" draggable={false} data-testid="plush-body"
        className="pointer-events-none absolute inset-0 size-full object-contain" style={{ filter: bodyFilter(shape, appearance.skin) }} />
      {parts.filter((id): id is keyof typeof PLUSH_OUTFITS => id in PLUSH_OUTFITS).map((id) =>
        <img key={id} src={`${PLUSH_ROOT}/${PLUSH_OUTFITS[id]}.webp`} alt="" draggable={false} data-testid={`plush-${id}`}
          className="pointer-events-none absolute object-contain" style={placementFor(shape, id)} />)}
      <HermesDrawingLayer strokes={appearance.drawing ?? []} />
    </motion.div>
  </motion.div>;
}
