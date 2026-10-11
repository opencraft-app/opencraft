'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { getHermesCharms, type HermesAppearance, type HermesCharm, type HermesSkin } from '@/lib/hermes-appearance';
import { cn } from '@/lib/utils';

export const HERMES_SOFT_ROOT = '/assets/mascot-dressup/soft';
export const HERMES_CHARM_LABELS: Record<HermesCharm, readonly [string, string]> = {
  beret: ['小贝雷帽', 'Beret'], headphones: ['薄荷耳机', 'Headphones'], star: ['星星徽章', 'Star pin'],
  moon: ['月亮徽章', 'Moon pin'], orbit: ['天线星环', 'Orbit ring'], wings: ['云朵小翼', 'Cloud wings'],
};

// Each layer uses the same 100% square coordinate frame. Body/antenna alone are tinted;
// eyes and ornaments retain their original material and light direction.
const SKIN_FILTER: Record<HermesSkin, string> = {
  butter: 'hue-rotate(155deg)', lavender: 'none', white: 'saturate(.18) brightness(1.055)', peach: 'hue-rotate(115deg) saturate(.85)',
  mint: 'hue-rotate(260deg) saturate(.72)', sky: 'hue-rotate(320deg) saturate(.82)',
  charcoal: 'grayscale(1) brightness(.34)',
};
const PLACEMENT: Record<HermesCharm, { left: string; top: string; width: string; height: string }> = {
  beret: { left: '28%', top: '32%', width: '27%', height: '15%' },
  headphones: { left: '23%', top: '32%', width: '54%', height: '41%' },
  star: { left: '57%', top: '65%', width: '10%', height: '10%' },
  moon: { left: '57%', top: '65%', width: '10%', height: '10%' },
  orbit: { left: '50.5%', top: '28%', width: '15%', height: '7%' },
  wings: { left: '12%', top: '50%', width: '76%', height: '25%' },
};

function Charm({ id }: { id: HermesCharm }) {
  return <img src={`${HERMES_SOFT_ROOT}/${id}.webp`} alt="" draggable={false}
    data-testid={`hermes-charm-${id}`} className="pointer-events-none absolute object-contain" style={PLACEMENT[id]} />;
}

export function HermesSoftAvatar({ appearance, size = 96, alive = false, reaction = 0, className }: {
  appearance: HermesAppearance; size?: number; alive?: boolean; reaction?: number; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false));
    observer.observe(element);
    const updatePageVisibility = () => setPageVisible(!document.hidden);
    updatePageVisibility();
    document.addEventListener('visibilitychange', updatePageVisibility);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', updatePageVisibility); };
  }, []);
  const reduced = useReducedMotion();
  const moving = alive && visible && pageVisible && !reduced;
  const [blink, setBlink] = useState(false);
  useEffect(() => {
    if (!moving) { setBlink(false); return; }
    let close: ReturnType<typeof setTimeout>;
    const timer = setInterval(() => { setBlink(true); close = setTimeout(() => setBlink(false), 150); }, 4300);
    return () => { clearInterval(timer); clearTimeout(close); };
  }, [moving]);
  const charms = getHermesCharms(appearance);
  const happy = appearance.expression === 'happy';
  const eye = happy ? 'smile' : 'eye';
  return <motion.div ref={ref} role="img" aria-label="Hermes" data-testid="dressup-preview" data-style="soft"
    className={cn('relative shrink-0', className)} style={{ width: size, height: size }}
    animate={{ y: moving ? [0, -3, 0] : 0 }} transition={moving ? { duration: 4, repeat: Infinity, ease: 'easeInOut' } : { duration: 0 }}>
    <motion.div className="absolute inset-0" key={`${charms.join('-')}-${reaction}`}
      initial={reduced || !alive ? false : { scale: .97, rotate: -2 }} animate={{ scale: 1, rotate: 0 }} transition={{ duration: .18 }}>
      {charms.includes('wings') && <Charm id="wings" />}
      <img src={`${HERMES_SOFT_ROOT}/body.webp`} alt="" draggable={false} className="pointer-events-none absolute inset-0 size-full object-contain" style={{ filter: SKIN_FILTER[appearance.skin] }} />
      {(appearance.skin === 'charcoal' || appearance.skin === 'white') && <img src={`${HERMES_SOFT_ROOT}/body.webp`} alt="" draggable={false}
        className="pointer-events-none absolute inset-0 size-full object-contain" style={{ clipPath: 'inset(0 0 64% 0)' }} />}
      {charms.filter((id) => id !== 'wings').map((id) => <Charm key={id} id={id} />)}
      {[0, 1].map((index) => {
        const wink = index === 1 && appearance.expression === 'wink';
        return <motion.img key={index} src={`${HERMES_SOFT_ROOT}/${wink ? 'smile' : eye}.webp`} alt="" draggable={false}
          className="pointer-events-none absolute object-fill" style={{ left: index ? '53%' : '42%', top: happy || wink ? '53%' : '49.5%', width: '4.8%', height: happy || wink ? '2.5%' : '9%', filter: appearance.skin === 'charcoal' && (happy || wink) ? 'invert(.92)' : undefined }}
          animate={{ scaleY: blink && !happy && !wink ? .08 : 1 }} transition={{ duration: reduced ? 0 : .075 }} />;
      })}
    </motion.div>
  </motion.div>;
}
