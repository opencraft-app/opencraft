'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { HERMES_SKIN_COLORS, type HermesAppearance, type HermesDoodad, type HermesDoodleShape, type HermesSkin } from '@/lib/hermes-appearance';
import { HermesDrawingLayer } from '@/components/site/hermes-drawing-layer';
import { cn } from '@/lib/utils';

export const DOODLE_ROOT = '/assets/mascot-dressup/doodle';
export const DOODLE_SHAPE_LABELS = {
  // Light + measure + cloud + sail (Vela): 轻量云 · LightVela, spelled out in the letters of the name.
  bean: ['游游', 'II'], round: ['轻轻', 'LL'], square: ['量量', 'HH'], drop: ['帆帆', 'VV'], cloud: ['云云', 'EE'],
} as const;
export const DOODLE_PART_LABELS = {
  'wizard-hat': ['星星巫师帽', 'Wizard hat'], 'bucket-hat': ['渔夫帽', 'Bucket hat'],
  goggles: ['飞行眼镜', 'Goggles'], beanie: ['针织帽', 'Knit beanie'],
  record: ['小唱片', 'Record'], book: ['小书本', 'Book'], camera: ['小相机', 'Camera'],
  crown: ['小皇冠', 'Crown'], 'star-glasses': ['星星眼镜', 'Star glasses'], 'sparkle-cheeks': ['星星贴纸', 'Star stickers'], wings: ['小翅膀', 'Little wings'],
  headphones: ['奶油耳机', 'Cream headphones'], 'bow-tie': ['蝴蝶结', 'Bow tie'], flower: ['小雏菊', 'Daisy'],
  beret: ['贝雷帽', 'Beret'], saturn: ['小行星', 'Little planet'], cape: ['小披风', 'Little cape'],
  glasses: ['小圆镜', 'Glasses'], scarf: ['小领巾', 'Bandana'], leaf: ['小叶子', 'Leaf pin'], cap: ['小帽子', 'Cap'], pencil: ['小铅笔', 'Pencil'],
} as const;
export const DOODLE_COLOR_INFO: Record<HermesSkin, readonly [string, string, string]> = {
  lavender: ['浅紫', 'Lilac', HERMES_SKIN_COLORS.lavender], peach: ['蜜桃', 'Peach', HERMES_SKIN_COLORS.peach], butter: ['奶黄', 'Butter', HERMES_SKIN_COLORS.butter],
  mint: ['薄荷', 'Mint', HERMES_SKIN_COLORS.mint], sky: ['晴空', 'Sky', HERMES_SKIN_COLORS.sky], charcoal: ['炭黑', 'Charcoal', HERMES_SKIN_COLORS.charcoal], white: ['珍珠白', 'Pearl', HERMES_SKIN_COLORS.white],
};
const BODY_FILTER: Record<HermesSkin, string> = {
  lavender: 'none', peach: 'hue-rotate(100deg) saturate(1.15)', butter: 'hue-rotate(145deg) saturate(.85) brightness(1.12)',
  mint: 'hue-rotate(245deg) saturate(.85)', sky: 'hue-rotate(310deg)', charcoal: 'grayscale(1) brightness(.36)', white: 'saturate(.15) brightness(1.06)',
};
// Anchors are relative to the normalized 800px sprite, independent of screen size.
const FIT: Record<HermesDoodleShape, { faceY: number; faceWidth: number; scarfY: number; scarfWidth: number; capY: number }> = {
  bean: { faceY: 49, faceWidth: 28, scarfY: 62, scarfWidth: 51, capY: 27 },
  round: { faceY: 49, faceWidth: 30, scarfY: 62, scarfWidth: 57, capY: 27 },
  square: { faceY: 49, faceWidth: 30, scarfY: 62, scarfWidth: 57, capY: 27 },
  drop: { faceY: 51, faceWidth: 26, scarfY: 64, scarfWidth: 52, capY: 29 },
  cloud: { faceY: 58, faceWidth: 28, scarfY: 69, scarfWidth: 45, capY: 40 },
};

export function HermesDoodleAvatar({ appearance, size = 96, alive = false, reaction = 0, className }: {
  appearance: HermesAppearance; size?: number; alive?: boolean; reaction?: number; className?: string;
}) {
  const shape = appearance.shape ?? 'bean';
  const fit = FIT[shape];
  const parts = appearance.doodads ?? [];
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [blink, setBlink] = useState(false);
  const [expressionPhase, setExpressionPhase] = useState(0);
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false));
    observer.observe(ref.current);
    const update = () => setPageVisible(!document.hidden);
    update(); document.addEventListener('visibilitychange', update);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, []);
  const moving = alive && visible && pageVisible && !reduced;
  useEffect(() => {
    if (!moving) { setBlink(false); return; }
    let close: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => { setBlink(true); close = setTimeout(() => setBlink(false), 140); }, 4200);
    return () => { clearInterval(timer); clearTimeout(close); };
  }, [moving]);
  useEffect(() => {
    if (!moving) { setExpressionPhase(0); return; }
    const duration = [4000, 1200, 3400, 1800][expressionPhase]!;
    const timer = setTimeout(() => setExpressionPhase((phase) => (phase + 1) % 4), duration);
    return () => clearTimeout(timer);
  }, [moving, expressionPhase]);
  const expression = moving ? (['open', 'wink', 'open', 'happy'] as const)[expressionPhase]! : appearance.expression;
  const inkFilter = appearance.skin === 'charcoal' ? 'brightness(0) invert(.95)' : undefined;
  // On charcoal the mouth and the closed eyes are drawn solid black; only accessories stay light.
  const faceInkFilter = appearance.skin === 'charcoal' ? 'brightness(0)' : undefined;
  const partStyle = (id: HermesDoodad) => {
    switch (id) {
      case 'crown': return { left: '29%', top: `${fit.capY - 6}%`, width: '25%', height: '16%', transform: 'rotate(-10deg)' };
      case 'star-glasses': return { left: `${50 - (fit.faceWidth + 19) / 2}%`, top: `${fit.faceY - 4}%`, width: `${fit.faceWidth + 19}%`, height: '17%' };
      case 'wings': return { left: '8%', top: `${fit.scarfY - 14}%`, width: '84%', height: '31%' };
      case 'sparkle-cheeks': return { left: '65%', top: `${fit.faceY + 8}%`, width: '9%', height: '10%' };
      case 'headphones': return { left: `${50 - (fit.scarfWidth + 8) / 2}%`, top: `${fit.capY - 3}%`, width: `${fit.scarfWidth + 8}%`, height: '50%' };
      case 'bow-tie': return { left: '41%', top: `${fit.scarfY + 5}%`, width: '18%', height: '11%' };
      case 'flower': return { left: '25%', top: `${fit.capY + 8}%`, width: '12%', height: '13%', transform: 'rotate(-12deg)' };
      case 'beret': return { left: '27%', top: `${fit.capY - 4}%`, width: '32%', height: '16%', transform: 'rotate(-12deg)' };
      case 'saturn': return { left: '62%', top: `${fit.scarfY + 6}%`, width: '15%', height: '13%', transform: 'rotate(-12deg)' };
      case 'cape': return { left: '13%', top: `${fit.scarfY - 5}%`, width: '74%', height: '28%' };
      case 'glasses': return { left: `${50 - (fit.faceWidth + 14) / 2}%`, top: `${fit.faceY - 6}%`, width: `${fit.faceWidth + 14}%`, height: '18%' };
      case 'scarf': return { left: `${50 - fit.scarfWidth / 2}%`, top: `${fit.scarfY}%`, width: `${fit.scarfWidth}%`, height: '23%' };
      case 'leaf': return { left: '65%', top: `${fit.scarfY - 3}%`, width: '11%', height: '15%' };
      case 'cap': return { left: '28%', top: `${fit.capY - 5}%`, width: '31%', height: '17%' };
      case 'pencil': return { left: '64%', top: `${fit.scarfY + 4}%`, width: '9%', height: '15%' };
    }
  };
  return <motion.div ref={ref} role="img" aria-label="Hermes" data-testid="dressup-preview" data-style="doodle" data-shape={shape} data-expression={expression}
    className={cn('relative shrink-0 select-none', className)} style={{ width: size, height: size }}
    animate={{ y: moving ? [0, -3, 0] : 0 }} transition={moving ? { duration: 4, repeat: Infinity, ease: 'easeInOut' } : { duration: 0 }}>
    <motion.div key={`${shape}-${reaction}`} className="absolute inset-0" initial={alive && !reduced ? { scale: .96, rotate: -2 } : false}
      animate={{ scale: 1, rotate: 0 }} transition={{ duration: .18 }}>
      {parts.includes('cape') && <img src={`${DOODLE_ROOT}/cape.webp`} alt="" draggable={false} data-testid="doodle-cape" className="pointer-events-none absolute object-contain" style={partStyle('cape')} />}
      {parts.includes('wings') && <img src={`${DOODLE_ROOT}/wings.webp`} alt="" draggable={false} data-testid="doodle-wings" className="pointer-events-none absolute object-contain" style={partStyle('wings')} />}
      <img src={`${DOODLE_ROOT}/body-${shape}.webp`} alt="" draggable={false} className="pointer-events-none absolute inset-0 size-full" style={{ filter: BODY_FILTER[appearance.skin] }} />
      {[0, 1].map((index) => <img key={`cheek-${index}`} src={`${DOODLE_ROOT}/cheek.webp`} alt="" draggable={false}
        className="pointer-events-none absolute object-fill" style={{ left: `${50 + (index ? 1 : -1) * (fit.faceWidth + 14) * .29 - 3.2}%`, top: `${fit.faceY + 8}%`, width: '6.4%', height: '3.8%', opacity: .5 }} />)}
      {[0, 1].map((index) => {
        const closed = expression === 'happy' || (index === 1 && expression === 'wink');
        const box = { left: `${50 + (index ? 1 : -1) * (fit.faceWidth + 14) * .233 - 2.7}%`, top: `${fit.faceY + (closed ? 2 : 0)}%`, width: '5.4%', height: closed ? '3%' : '8.2%' };
        const motionProps = { animate: { scaleY: blink && !closed ? .08 : 1 }, transition: { duration: reduced ? 0 : .07 } };
        // The open eye is a dark capsule whose highlight is a transparent notch. Turning it white
        // on charcoal fills the capsule and leaves the notch dark, which reads as rolled-up eyes.
        // Keep it near black and put a white glint behind the notch instead.
        if (appearance.skin === 'charcoal' && !closed) {
          return <motion.span key={index} aria-hidden="true" className="pointer-events-none absolute" style={box} {...motionProps}>
            <img src={`${DOODLE_ROOT}/eye.webp`} alt="" draggable={false} data-testid="doodle-eye-glint" className="absolute inset-0 size-full object-fill" style={{ filter: 'brightness(0) invert(.95)', transform: 'scale(.62)' }} />
            <img src={`${DOODLE_ROOT}/eye.webp`} alt="" draggable={false} className="absolute inset-0 size-full object-fill" style={{ filter: 'brightness(.4)' }} />
          </motion.span>;
        }
        return <motion.img key={index} src={`${DOODLE_ROOT}/${closed ? 'closed-eye' : 'eye'}.webp`} alt="" draggable={false}
          className="pointer-events-none absolute object-fill" style={{ ...box, filter: closed ? faceInkFilter : inkFilter }} {...motionProps} />;
      })}
      <img src={`${DOODLE_ROOT}/mouth.webp`} alt="" draggable={false} className="pointer-events-none absolute object-fill" style={{ left: '46%', top: `${fit.faceY + 9}%`, width: '8%', height: '3.5%', filter: faceInkFilter }} />
      {parts.filter((id) => id !== 'wings' && id !== 'cape').map((id) => <img key={id} src={`${DOODLE_ROOT}/${id}.webp`} alt="" draggable={false} data-testid={`doodle-${id}`}
        className="pointer-events-none absolute object-contain" style={{ ...partStyle(id), filter: id === 'glasses' ? inkFilter : undefined }} />)}
      {parts.includes('sparkle-cheeks') && <img src={`${DOODLE_ROOT}/sparkle-cheeks.webp`} alt="" draggable={false} className="pointer-events-none absolute object-contain" style={{ ...partStyle('sparkle-cheeks'), left: '26%', transform: 'rotate(-15deg) scale(.8)' }} />}
      <HermesDrawingLayer strokes={appearance.drawing ?? []} />
    </motion.div>
  </motion.div>;
}
