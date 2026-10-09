'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useId, useRef, useState } from 'react';
import { HermesDrawingLayer } from '@/components/site/hermes-drawing-layer';
import { HERMES_SKIN_COLORS, type HermesAppearance, type HermesDoodleShape, type HermesSkin } from '@/lib/hermes-appearance';
import { cn } from '@/lib/utils';

export const PLUSH_ROOT = '/assets/mascot-dressup/plush';
export const PLUSH_OUTFITS = {
  headphones: 'headphones-v2', 'wizard-hat': 'wizard-hat', 'bucket-hat': 'bucket-hat-v2',
  'star-glasses': 'star-glasses', goggles: 'goggles-v2', beret: 'beret-v2', beanie: 'beanie',
  cape: 'cape', scarf: 'scarf-v2', record: 'record-v2', book: 'book-v2', camera: 'camera-v2',
} as const;

// The source bodies have different native colours and exposure. Map their
// measured body midtone to one palette, rather than rotating unequal RGB hues.
const BODY_MIDTONE: Record<HermesDoodleShape, number> = { round: .788, bean: .752, square: .862, drop: .779, cloud: .873 };
function colourTable(shape: HermesDoodleShape, skin: HermesSkin, channel: 0 | 1 | 2) {
  const tone = Number.parseInt(HERMES_SKIN_COLORS[skin].slice(1 + channel * 2, 3 + channel * 2), 16) / 255, mid = BODY_MIDTONE[shape];
  // Keep black eyes and white specular highlights; only body tones are remapped.
  const anchors = [[.22, .22], [mid - .24, tone * .70], [mid, tone], [.99, 1], [1, 1]] as const;
  return Array.from({ length: 65 }, (_, index) => {
    const x = index / 64;
    let x0 = 0, y0 = 0;
    for (const [x1, y1] of anchors) {
      if (x <= x1) return (y0 + (y1 - y0) * (x - x0) / (x1 - x0)).toFixed(4);
      x0 = x1; y0 = y1;
    }
    return '1';
  }).join(' ');
}

// Anchors refer to the approved frontal body canvas, including its transparent margin.
// Eye spacing stays stable across shapes; headwear follows the silhouette instead.
type PlushAnchor = {
  centerX: number; headWidth: number; crownWidth: number; bodyWidth: number;
  eyeY: number; foreheadY: number; neckY: number; handY: number; handL: number; handR: number;
};
const PLUSH_ANCHORS: Record<HermesDoodleShape, PlushAnchor> = {
  round: { centerX: .49, headWidth: .51, crownWidth: .48, bodyWidth: .51, eyeY: .552, foreheadY: .405, neckY: .657, handY: .739, handL: .307, handR: .686 },
  bean: { centerX: .49, headWidth: .42, crownWidth: .40, bodyWidth: .42, eyeY: .549, foreheadY: .395, neckY: .657, handY: .737, handL: .321, handR: .673 },
  square: { centerX: .49, headWidth: .52, crownWidth: .51, bodyWidth: .52, eyeY: .553, foreheadY: .417, neckY: .657, handY: .737, handL: .301, handR: .688 },
  drop: { centerX: .49, headWidth: .48, crownWidth: .37, bodyWidth: .50, eyeY: .587, foreheadY: .463, neckY: .689, handY: .744, handL: .304, handR: .686 },
  cloud: { centerX: .515, headWidth: .80, crownWidth: .55, bodyWidth: .80, eyeY: .582, foreheadY: .405, neckY: .71, handY: .663, handL: .273, handR: .753 },
};

type PlushOutfit = Exclude<keyof typeof PLUSH_OUTFITS, 'headphones'>;
type PlushSlot = 'head' | 'eyes' | 'forehead' | 'neck' | 'hold';
const PLUSH_FIT: Record<PlushOutfit, { slot: PlushSlot; aspect: number; width: number; dx?: number; dy?: number }> = {
  'wizard-hat': { slot: 'head', aspect: .831, width: 1.02, dx: -.04 },
  'bucket-hat': { slot: 'head', aspect: .575, width: 1 },
  beret: { slot: 'head', aspect: .48, width: .98 },
  beanie: { slot: 'head', aspect: .65, width: .97, dy: .032 },
  'star-glasses': { slot: 'eyes', aspect: .471, width: .39 },
  goggles: { slot: 'forehead', aspect: 0.421, width: .94 },
  cape: { slot: 'neck', aspect: .432, width: 1.12 },
  scarf: { slot: 'neck', aspect: 0.436, width: .71 },
  record: { slot: 'hold', aspect: 0.993, width: .47, dx: -.04 },
  book: { slot: 'hold', aspect: 1.074, width: .58 },
  camera: { slot: 'hold', aspect: 0.691, width: .65 },
};
const HEADWEAR_ANCHORS: Record<HermesDoodleShape, { width: number; brimY: number }> = {
  round: { width: .56, brimY: .46 }, bean: { width: .48, brimY: .45 },
  square: { width: .57, brimY: .47 }, drop: { width: .54, brimY: .51 },
  cloud: { width: .60, brimY: .45 },
};

// The head occludes only the middle of the opening. Keep both side returns
// of the brim/knit cuff so the hat wraps around, instead of losing its depth.
// Wizard and knit hats have their own tilted/rolled lower edges.
const HAT_BRIM_CLIPS: Partial<Record<PlushOutfit, string>> = {
  'bucket-hat': 'M0 0H1V1H.88Q.86 .89 .76 .83Q.5 .65 .24 .83Q.14 .89 .12 1H0Z',
  beret: 'M0 0H1V1H.86Q.85 .94 .75 .86Q.5 .7 .25 .86Q.15 .94 .14 1H0Z',
  'wizard-hat': 'M0 0H1V1H.9Q.9 .85 .85 .72Q.72 .78 .46 .86Q.2 .94 .18 1H0Z',
  beanie: 'M0 0H1V1H.85Q.84 .95 .76 .92Q.5 .85 .24 .88Q.15 .89 .15 1H0Z',
};

const HAT_CONTACT_CURVES: Partial<Record<PlushOutfit, string>> = {
  'bucket-hat': 'M.12 1Q.14 .89 .24 .83Q.5 .65 .76 .83Q.86 .89 .88 1',
  beret: 'M.14 1Q.15 .94 .25 .86Q.5 .7 .75 .86Q.85 .94 .86 1',
  'wizard-hat': 'M.18 1Q.2 .94 .46 .86Q.72 .78 .85 .72',
  beanie: 'M.20 .884Q.48 .843 .80 .927',
};

const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
function placementFor(shape: HermesDoodleShape, id: PlushOutfit): React.CSSProperties {
  const a = PLUSH_ANCHORS[shape], fit = PLUSH_FIT[id];
  const width = fit.slot === 'eyes' ? (shape === 'cloud' ? .35 : fit.width)
    : fit.slot === 'head' ? HEADWEAR_ANCHORS[shape].width * fit.width
    : fit.slot === 'forehead' ? a.crownWidth * fit.width
    : a.bodyWidth * fit.width;
  const fittedWidth = shape === 'cloud'
    ? id === 'cape' ? .55 : fit.slot === 'hold' ? (id === 'book' ? .218 : width * .65) : id === 'scarf' ? width * .78 : width
    : width;
  const height = fittedWidth * fit.aspect;
  const top = fit.slot === 'head' ? HEADWEAR_ANCHORS[shape].brimY - height
    : fit.slot === 'eyes' ? a.eyeY - height / 2
    : fit.slot === 'forehead' ? a.foreheadY - height / 2
    : fit.slot === 'neck' ? (shape === 'cloud' ? (id === 'cape' ? .68 : .69) : a.neckY - .035)
    : shape === 'cloud' ? (id === 'camera' ? .69 : .66) : a.handY - height * .30;
  const centerX = shape === 'cloud' && fit.slot === 'hold' ? (id === 'book' ? .38 : .40) : a.centerX + (fit.dx ?? 0);
  return { left: pct(centerX - fittedWidth / 2), top: pct(top + (fit.dy ?? 0)), width: pct(fittedWidth), height: pct(height),
    filter: 'drop-shadow(0 1px 1px rgba(67,44,80,.10))' };
}

// A one-piece headphone image couples ear spacing to cushion size. Anchor the
// two cushions independently so narrow heads do not put them across the eyes.
const HEADPHONE_ANCHORS: Record<HermesDoodleShape, { left: number; right: number; y: number; width: number; height: number; bandTop: number }> = {
  round: { left: .225, right: .755, y: .575, width: .16, height: .19, bandTop: .32 },
  bean: { left: .265, right: .715, y: .57, width: .145, height: .185, bandTop: .31 },
  square: { left: .22, right: .76, y: .575, width: .16, height: .19, bandTop: .325 },
  drop: { left: .235, right: .745, y: .605, width: .16, height: .19, bandTop: .34 },
  cloud: { left: .175, right: .855, y: .60, width: .18, height: .205, bandTop: .325 },
};
function HeadphonesLayer({ shape }: { shape: HermesDoodleShape }) {
  const a = HEADPHONE_ANCHORS[shape];
  const src = `${PLUSH_ROOT}/${PLUSH_OUTFITS.headphones}.webp`;
  const cupTop = a.y - a.height / 2;
  const bandWidth = (a.right - a.left) / .8;
  const bandHeight = (cupTop + .01 - a.bandTop) / .46;
  return <span data-testid="plush-headphones" className="pointer-events-none absolute inset-0">
    <img src={src} alt="" draggable={false} className="absolute object-fill"
      style={{ left: pct((a.left + a.right - bandWidth) / 2), top: pct(a.bandTop), width: pct(bandWidth), height: pct(bandHeight), clipPath: 'inset(0 0 54% 0)' }} />
    {[a.left, a.right].map((x, index) => <span key={index} className="absolute overflow-hidden"
      style={{ left: pct(x - a.width / 2), top: pct(cupTop), width: pct(a.width), height: pct(a.height) }}>
      <img src={src} alt="" draggable={false} className="absolute max-w-none object-fill"
        style={{ width: '253.17%', height: '181.82%', top: '-81.82%', ...(index === 0 ? { left: 0 } : { right: 0 }) }} />
    </span>)}
  </span>;
}

export function HermesPlushAvatar({ appearance, size = 96, alive = false, reaction = 0, className }: {
  appearance: HermesAppearance; size?: number; alive?: boolean; reaction?: number; className?: string;
}) {
  const colourId = `plush-colour-${useId().replace(/:/g, '')}`;
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
  const anchor = PLUSH_ANCHORS[shape];
  const bodyStyle = { filter: `url(#${colourId})` };
  // Remove each native antenna as a whole. A single continuous stem joins
  // the shared orb to the head; cropped raster stems left disconnected pixels.
  const bodyClip = shape === 'cloud'
    ? 'polygon(0 0,46% 0,46% 28%,77% 28%,77% 0,100% 0,100% 100%,0 100%)'
    : 'polygon(0 0,37% 0,37% 31%,61% 31%,61% 0,100% 0,100% 100%,0 100%)';

  const bodySrc = `${PLUSH_ROOT}/${shape === 'cloud' ? 'body-cloud' : `front-${shape}`}.webp`;
  const hasForeground = parts.some((id) => ['book', 'camera', 'record', 'cape', 'scarf'].includes(id));
  const moving = alive && visible && pageVisible && !reduced;
  return <motion.div ref={ref} role="img" aria-label="Hermes" data-testid="dressup-preview" data-style="doodle" data-shape={shape}
    className={cn('relative shrink-0 select-none', className)} style={{ width: size, height: size }}
    animate={{ y: moving ? [0, -3, 0] : 0 }} transition={moving ? { duration: 4, repeat: Infinity, ease: 'easeInOut' } : { duration: 0 }}>
    <svg width="0" height="0" aria-hidden="true" className="pointer-events-none absolute">
      <defs><filter id={colourId} colorInterpolationFilters="sRGB">
        <feColorMatrix type="saturate" values="0" />
        <feComponentTransfer>
          <feFuncR type="table" tableValues={colourTable(shape, appearance.skin, 0)} />
          <feFuncG type="table" tableValues={colourTable(shape, appearance.skin, 1)} />
          <feFuncB type="table" tableValues={colourTable(shape, appearance.skin, 2)} />
        </feComponentTransfer>
      </filter>
        <filter id={`${colourId}-stem`} colorInterpolationFilters="sRGB">
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncR type="table" tableValues={colourTable('bean', appearance.skin, 0)} />
            <feFuncG type="table" tableValues={colourTable('bean', appearance.skin, 1)} />
            <feFuncB type="table" tableValues={colourTable('bean', appearance.skin, 2)} />
          </feComponentTransfer>
        </filter>
        {Object.entries(HAT_BRIM_CLIPS).map(([id, path]) => <clipPath key={id} id={`${colourId}-${id}-brim`} clipPathUnits="objectBoundingBox"><path d={path} /></clipPath>)}
      </defs>
    </svg>
    <motion.div key={`${shape}-${reaction}`} className="absolute inset-0" initial={alive && !reduced ? { scale: .97, rotate: -1.5 } : false}
      animate={{ scale: 1, rotate: 0 }} transition={{ duration: .18 }}>
      <img src={`${PLUSH_ROOT}/front-bean.webp`} alt="" draggable={false} data-testid="plush-antenna-stem"
        className="pointer-events-none absolute inset-0 size-full object-contain"
        style={{ filter: `url(#${colourId}-stem)`, clipPath: 'polygon(47% 24%,53% 24%,53% 33%,47% 33%)', transform: 'rotate(18deg) scaleY(1.5)', transformOrigin: '50% 32.5%' }} />
      <img src={bodySrc} alt="" draggable={false} data-testid="plush-body"
        className="pointer-events-none absolute inset-0 size-full object-contain" style={{ ...bodyStyle, clipPath: bodyClip }} />
      <svg viewBox="0 0 100 100" aria-hidden="true" className="pointer-events-none absolute inset-0 size-full">
        <defs>
          <mask id={`${colourId}-head-surface`} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100" style={{ maskType: 'alpha' }}>
            <image href={bodySrc} width="100" height="100" />
          </mask>
          <filter id={`${colourId}-contact`} x="-20%" y="-100%" width="140%" height="300%"><feGaussianBlur stdDeviation=".4" /></filter>
        </defs>
        <g mask={`url(#${colourId}-head-surface)`} filter={`url(#${colourId}-contact)`}>
          {parts.filter((id): id is PlushOutfit => id in HAT_CONTACT_CURVES).map((id) => {
            const p = placementFor(shape, id);
            return <path key={id} d={HAT_CONTACT_CURVES[id]} transform={`translate(${Number.parseFloat(String(p.left))} ${Number.parseFloat(String(p.top)) + .5}) scale(${Number.parseFloat(String(p.width))} ${Number.parseFloat(String(p.height))})`}
              fill="none" stroke="#493348" strokeOpacity={id === 'beanie' ? .12 : .2} strokeWidth={id === 'beanie' ? .018 : .025} strokeLinecap="round" />;
          })}
        </g>
      </svg>
      {parts.includes('headphones') && <HeadphonesLayer shape={shape} />}
      {parts.filter((id): id is PlushOutfit => id !== 'headphones' && id in PLUSH_OUTFITS).map((id) =>
        <img key={id} src={`${PLUSH_ROOT}/${PLUSH_OUTFITS[id]}.webp`} alt="" draggable={false} data-testid={`plush-${id}`}
          className={cn('pointer-events-none absolute', PLUSH_FIT[id].slot === 'head' ? 'object-fill' : 'object-contain')} style={{ ...placementFor(shape, id), clipPath: HAT_BRIM_CLIPS[id] ? `url(#${colourId}-${id}-brim)` : undefined }} />)}
      {shape === 'cloud' && <svg viewBox="0 0 512 512" aria-hidden="true" className="pointer-events-none absolute inset-0 size-full"><path d="M251 339q12 13 24 0" fill="none" stroke="#342b35" strokeWidth="6" strokeLinecap="round" /></svg>}
      {/* Preserve the pearlescent antenna orb when changing the body colour. */}
      <img src={`${PLUSH_ROOT}/front-bean.webp`} alt="" draggable={false} data-testid="plush-orb" className="pointer-events-none absolute inset-0 size-full object-contain"
        style={{ transform: 'translate(6%, -3%)', clipPath: 'ellipse(10.4% 10.1% at 50% 14%)' }} />
      {hasForeground && [anchor.handL, anchor.handR].map((handX) => <img key={handX} src={bodySrc} alt="" draggable={false}
        className="pointer-events-none absolute inset-0 size-full object-contain" style={{ ...bodyStyle, clipPath: `ellipse(6% 5.8% at ${pct(handX)} ${pct(anchor.handY)})` }} />)}
      <HermesDrawingLayer strokes={appearance.drawing ?? []} />
    </motion.div>
  </motion.div>;
}
