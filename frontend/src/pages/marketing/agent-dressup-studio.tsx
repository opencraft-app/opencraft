'use client';

import { ArrowLeft, Check, RefreshCw, Shuffle, Pencil, Ban } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';

import { useCurrentLocale } from '@/i18n/t';
import { DOODLE_COLOR_INFO, DOODLE_PART_LABELS, DOODLE_SHAPE_LABELS } from '@/components/site/hermes-doodle-avatar';
import { HermesPlushAvatar, PLUSH_ROOT, PLUSH_OUTFITS } from '@/components/site/hermes-plush-avatar';
import {
  DEFAULT_HERMES_APPEARANCE, HERMES_DOODLE_SHAPES, HERMES_DOODLE_COLORS, HERMES_PLAYFUL_DOODADS, asDoodleAppearance, toggleHermesDoodad,
  HERMES_ACCESSORY_PIECE, getHermesAccessories,
  type HermesAppearance, type HermesPiece,
} from '@/lib/hermes-appearance';
import { cn } from '@/lib/utils';
import { HermesDrawingEditor } from '@/components/site/hermes-drawing-editor';
import { HermesSoftAvatar } from '@/components/site/hermes-soft-avatar';

const ROOT = '/assets/mascot-dressup';
const WINK_ASSET = new Set(['white', 'peach', 'charcoal']);
const RASTER_GARMENTS: Partial<Record<'hat' | 'top' | 'shoes', Partial<Record<Exclude<HermesPiece, 'none'>, { file: string; transform: string }>>>> = {
  top: {
    sport: { file: 'top-sport-3d.webp', transform: 'translateY(14%) scale(.46)' },
    classic: { file: 'top-classic-3d-v2.webp', transform: 'translateY(14%) scale(.58)' },
    explorer: { file: 'top-explorer-3d.webp', transform: 'translateY(12%) scale(.76)' },
  },
  hat: { explorer: { file: 'hat-explorer-3d-v2.webp', transform: 'translateY(-10%) scale(.55)' } },
  shoes: {
    sport: { file: 'shoes-sport-3d.webp', transform: 'translateY(23%) scale(.42)' },
    explorer: { file: 'shoes-explorer-3d.webp', transform: 'translateY(21%) scale(.52)' },
  },
};

function GarmentLayer({ slot, piece }: { slot: 'hat' | 'top' | 'shoes'; piece: Exclude<HermesPiece, 'none'> }) {
  const common = 'absolute inset-0 size-full overflow-visible';
  const raster = RASTER_GARMENTS[slot]?.[piece];
  if (raster) return <img src={`${ROOT}/${raster.file}`} alt="" draggable={false} data-testid={`dressup-${slot}`}
    className="absolute inset-0 size-full object-contain" style={{ transform: raster.transform }} />;
  if (slot === 'hat') return <svg viewBox="0 0 800 800" className={common} aria-hidden="true" data-testid="dressup-hat">
    {piece === 'classic' ? <g><path d="M242 315c7-47 49-73 105-70 46 2 74 25 87 68-63 15-130 17-192 2Z" fill="#faf7f1" stroke="#d6cbe6" strokeWidth="8"/><path d="M228 315c77 22 149 18 223-4" fill="none" stroke="#b8a6d9" strokeWidth="12" strokeLinecap="round"/></g>
      : piece === 'sport' ? <g><path d="M232 319c12-42 59-68 111-65 51 3 84 26 95 62-64 15-140 20-206 3Z" fill="#d7caf7" stroke="#aa92df" strokeWidth="8"/><path d="M220 319c75 24 156 23 229-2" fill="none" stroke="#775ac1" strokeWidth="13" strokeLinecap="round"/></g>
        : <g><path d="M231 317c18-47 61-69 115-68 53 1 86 24 98 65-62 17-145 21-213 3Z" fill="#f3e5c8" stroke="#bca88c" strokeWidth="8"/><path d="M222 319c77 25 157 20 232-3" fill="none" stroke="#8a739e" strokeWidth="14" strokeLinecap="round"/><circle cx="327" cy="269" r="10" fill="#ba9be8"/></g>}
  </svg>;
  if (slot === 'top') return <svg viewBox="0 0 800 800" className={common} aria-hidden="true" data-testid="dressup-top">
    {piece === 'classic' ? <g><path d="M303 525c19 6 42 9 66 8l26 75-75 23c-20-28-25-66-17-106Zm194 8c24 1 47-2 66-8 8 40 3 78-17 106l-75-23 26-75Z" fill="#fffaf3" stroke="#cfc2dc" strokeWidth="9"/><path d="m369 533 31 27 31-27-31 80Z" fill="#8b76c7"/><circle cx="400" cy="565" r="8" fill="#f1d5a6"/></g>
      : piece === 'sport' ? <g><path d="M291 543q27-16 58-16l29 75q-24 21-66 23-25-33-21-82Zm160-16q31 0 58 16 4 49-21 82-42-2-66-23Z" fill="#e5dafa" fillOpacity=".82" stroke="#bca8e6" strokeWidth="7" strokeLinejoin="round"/><path d="m351 528 49 47 49-47" fill="none" stroke="#a68fe5" strokeWidth="9" strokeLinecap="round"/><path d="M400 575v60" stroke="#b9a4e8" strokeWidth="7"/><path d="M310 624q42 15 90 13 48 2 90-13" fill="none" stroke="#d2c3f4" strokeWidth="8" strokeLinecap="round"/></g>
        : <g><path d="M284 531c27-9 44-7 64-4l21 83-65 22c-22-27-26-67-20-101Zm168-4c20-3 37-5 64 4 6 34 2 74-20 101l-65-22 21-83Z" fill="#efebf8" stroke="#a99ac9" strokeWidth="9"/><path d="M345 530c5 38 17 74 43 103m67-103c-5 38-17 74-43 103" stroke="#baa7dd" strokeWidth="12" fill="none"/><rect x="551" y="541" width="58" height="91" rx="22" fill="#ceb9ee" stroke="#9b83c4" strokeWidth="8"/></g>}
  </svg>;
  return <svg viewBox="0 0 800 800" className={common} aria-hidden="true" data-testid="dressup-shoes">
    {piece === 'classic' ? <g fill="#fffaf3" stroke="#b6a8d4" strokeWidth="8"><path d="M287 680q41 13 77 2l9 28q-6 21-48 22-50 1-54-20Z"/><path d="M435 682q36 11 77-2l16 32q-4 21-54 20-42-1-48-22Z"/></g>
      : piece === 'sport' ? <g fill="#f9f8ff" stroke="#a896d4" strokeWidth="8"><path d="M286 677q41 16 78 3l12 30q-7 19-53 22-51 0-56-21Z"/><path d="M436 680q37 13 78-3l19 34q-5 21-56 21-46-3-53-22Z"/><path d="M274 714q51 11 94-2m69 0q43 13 91 2" fill="none" stroke="#bba8ec" strokeWidth="10"/></g>
        : <g fill="#ece3d3" stroke="#9b89b0" strokeWidth="8"><path d="M283 673q43 16 84 2l13 34q-3 24-54 26-57 0-58-26Z"/><path d="M433 675q41 14 84-2l15 36q-1 26-58 26-51-2-54-26Z"/><path d="M295 704h67m76 0h67" stroke="#8773a5" strokeWidth="9"/></g>}
  </svg>;
}

function useBlink(enabled: boolean) {
  const [blink, setBlink] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setInterval(() => {
      setBlink(true);
      window.setTimeout(() => setBlink(false), 170);
    }, 4600);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return blink;
}

export function HermesAppearanceAvatar({ appearance, size = 96, alive = false, portrait = false, className }: {
  appearance: HermesAppearance;
  size?: number;
  alive?: boolean;
  portrait?: boolean;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const blink = useBlink(alive && !reduced && !appearance.style);
  const wink = appearance.expression === 'wink' || (appearance.expression === 'open' && blink);
  const nativeWink = wink && WINK_ASSET.has(appearance.skin);
  // The body occludes backpack straps; foreground accessories share the same canvas anchor.
  const accessories = getHermesAccessories(appearance);
  const base = `${ROOT}/${nativeWink ? 'wink' : 'base'}-${appearance.skin}.webp`;
  if (portrait) return <span className={cn('relative inline-block shrink-0 overflow-hidden rounded-full bg-[#f4f0fa]', className)} style={{ width: size, height: size }}>
    <span className="absolute left-1/2 top-0" style={{ width: size * 1.85, height: size * 1.85, transform: 'translate(-50%, -22%)' }}>
      <HermesAppearanceAvatar appearance={appearance} size={size * 1.85} />
    </span>
  </span>;
  if (appearance.style === 'doodle') return <HermesPlushAvatar appearance={appearance} size={size} alive={alive} className={className} />;
  if (appearance.style === 'soft') return <HermesSoftAvatar appearance={appearance} size={size} alive={alive} className={className} />;
  return (
    <motion.div
      className={cn('relative shrink-0', className)}
      style={{ width: size, height: size }}
      animate={alive && !reduced ? { y: [0, -3, 0] } : { y: 0 }}
      transition={alive && !reduced ? { duration: 3.8, repeat: Infinity, ease: 'easeInOut' } : { duration: 0 }}
      role="img"
      aria-label="Hermes"
      data-testid="dressup-preview"
    >
      {accessories.includes('backpack') && <GarmentLayer slot="top" piece="explorer" />}
      <img src={base} alt="" draggable={false} className="absolute inset-0 size-full object-contain" />
      {appearance.shoes !== 'none' && <GarmentLayer slot="shoes" piece={appearance.shoes} />}
      {accessories.filter((accessory) => accessory !== 'backpack').map((accessory) => <GarmentLayer key={accessory} slot="top" piece={HERMES_ACCESSORY_PIECE[accessory]} />)}
      {appearance.hat !== 'none' && <GarmentLayer slot="hat" piece={appearance.hat} />}
      {appearance.expression === 'happy' && <svg aria-hidden="true" viewBox="0 0 800 800" className="absolute inset-0 size-full">
        <path d="M376 499q24 27 48 0" fill="none" stroke={appearance.skin === 'charcoal' ? '#e3d7fa' : '#302b40'} strokeWidth="9" strokeLinecap="round" />
      </svg>}
      {wink && !nativeWink && <>
        <span aria-hidden="true" className="absolute inset-0 overflow-hidden" style={{ clipPath: 'ellipse(5% 7.5% at 55% 53.5%)' }}><img src={base} alt="" className="absolute inset-0 size-full -translate-x-[12%]" /></span>
        <svg aria-hidden="true" viewBox="0 0 800 800" className="absolute inset-0 size-full"><path d="M418 431q22-17 44 0" fill="none" stroke="#242034" strokeWidth="17" strokeLinecap="round" /></svg>
      </>}
    </motion.div>
  );
}

// Curated accessory sets that read well together; the empty set is only for the full studio.
const LOOK_COMBINATIONS = [['headphones', 'record'], ['wizard-hat', 'cape'], ['bucket-hat', 'book'], ['star-glasses'], ['goggles', 'scarf'], ['beret', 'camera'], ['beanie'], ['headphones', 'star-glasses']] as const;
const pickOther = <T,>(list: readonly T[], current: T, same: (a: T, b: T) => boolean = (a, b) => a === b): T => {
  const options = list.filter((item) => !same(item, current));
  return (options.length ? options : list)[Math.floor(Math.random() * (options.length || list.length))]!;
};
/** A fresh look that differs from `current` in silhouette, colour and accessories alike. */
export function rollHermesLook(value: HermesAppearance, allowBare = false): HermesAppearance {
  const current = asDoodleAppearance(value);
  const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item) => b.includes(item));
  const sets: readonly (readonly string[])[] = allowBare ? [...LOOK_COMBINATIONS, []] : LOOK_COMBINATIONS;
  return {
    ...current,
    shape: pickOther(HERMES_DOODLE_SHAPES, current.shape ?? 'bean'),
    skin: pickOther(HERMES_DOODLE_COLORS, current.skin),
    doodads: [...pickOther(sets, current.doodads ?? [], sameSet)] as typeof current.doodads,
  };
}

// Tailwind v4 resets buttons to an arrow cursor; every control here is clickable.
const FOCUS = 'cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500';

type DressupStep = 'base-color' | 'shape' | 'color' | 'extras' | 'done';
const DRESSUP_STEPS = ['base-color', 'shape', 'color', 'extras'] as const;

/** Pick an initial colour, shape, refine the colour, then add independent accessories. */
export function HermesStepDressup({ appearance, onChange, zh }: {
  appearance: HermesAppearance; onChange: (next: HermesAppearance) => void; zh: boolean;
}) {
  const label = (cnLabel: string, enLabel: string) => zh ? cnLabel : enLabel;
  const current = asDoodleAppearance(appearance);
  const parts = current.doodads ?? [];
  const [step, setStep] = useState<DressupStep>('base-color');
  const [drawingOpen, setDrawingOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const drawingButton = useRef<HTMLButtonElement>(null);
  const previousStep = useRef(step);
  const wasDrawing = useRef(false);
  useEffect(() => {
    if (previousStep.current !== step) heading.current?.focus();
    previousStep.current = step;
  }, [step]);
  useEffect(() => {
    if (wasDrawing.current && !drawingOpen) drawingButton.current?.focus();
    wasDrawing.current = drawingOpen;
  }, [drawingOpen]);
  if (drawingOpen) return <HermesDrawingEditor appearance={current} zh={zh} onCancel={() => setDrawingOpen(false)} onConfirm={(drawing) => { onChange({ ...current, drawing }); setDrawingOpen(false); }} />;

  const stepIndex = DRESSUP_STEPS.indexOf(step as typeof DRESSUP_STEPS[number]);
  const titles: Record<DressupStep, string> = {
    'base-color': label('先选个颜色', 'Pick a colour'), shape: label('选个形状', 'Pick a shape'), color: label('再选个颜色', 'Pick a colour'),
    extras: label('最后加点配饰', 'Add some extras'), done: label('我的 Hermes', 'My Hermes'),
  };
  const back: DressupStep | null = step === 'shape' ? 'base-color' : step === 'color' ? 'shape' : step === 'extras' ? 'color' : null;
  const shuffle = () => onChange(rollHermesLook(current));
  return <section aria-label={label('我的 Hermes', 'My Hermes')} className="flex flex-col items-center py-2">
    <div className="relative flex w-full justify-center">
      {back && <button type="button" onClick={() => setStep(back)} className={cn('absolute left-0 top-0 flex min-h-11 items-center gap-1 rounded-md text-xs text-[#777184]', FOCUS)}><ArrowLeft size={14} />{label('上一步', 'Back')}</button>}
      <div className="rounded-full bg-[#f8f5ff]"><HermesAppearanceAvatar appearance={current} size={step === 'done' ? 196 : 180} alive /></div>
    </div>
    <h3 ref={heading} tabIndex={-1} className="mt-2 text-sm font-semibold text-[#28223a] outline-none">{titles[step]}</h3>
    {step === 'done'
      ? <p className="mt-1 text-xs text-[#777184]">{label('就是它了，还可以再换。', 'That is the one. You can still change it.')}</p>
      : <ol aria-label={label(`第 ${stepIndex + 1} 步，共 4 步`, `Step ${stepIndex + 1} of 4`)} className="mt-2 flex gap-1.5">
        {DRESSUP_STEPS.map((id, index) => <li key={id} aria-hidden="true" className={cn('h-1.5 rounded-full transition-all', index === stepIndex ? 'w-5 bg-[#7450d9]' : index < stepIndex ? 'w-1.5 bg-[#b9a4ee]' : 'w-1.5 bg-[#e3ddee]')} />)}
      </ol>}

    {step === 'shape' && <div role="group" aria-label={label('形状', 'Shape')} className="mt-3 grid w-full grid-cols-5 gap-1">
      {HERMES_DOODLE_SHAPES.map((shape) => <button key={shape} type="button" aria-label={DOODLE_SHAPE_LABELS[shape][zh ? 0 : 1]} aria-pressed={current.shape === shape}
        onClick={() => { onChange({ ...current, shape }); setStep('color'); }} className={cn('group flex min-w-0 flex-col items-center rounded-md pb-1 text-xs text-[#777087]', FOCUS)}>
        <span className={cn('flex aspect-square w-full max-w-[78px] items-center justify-center rounded-full transition-colors group-hover:bg-[#f8f5ff]', current.shape === shape && 'bg-[#f4efff]')}>
          <HermesPlushAvatar appearance={{ ...current, shape, doodads: [], expression: 'open', drawing: [] }} size={76} className="!size-full" />
        </span>
      </button>)}
    </div>}

    {(step === 'base-color' || step === 'color') && <div role="group" aria-label={label('颜色', 'Colour')} className="mt-3 grid w-full grid-cols-5 gap-0.5">
      {HERMES_DOODLE_COLORS.map((skin) => <button type="button" key={skin} aria-label={DOODLE_COLOR_INFO[skin][zh ? 0 : 1]} aria-pressed={current.skin === skin}
        onClick={() => { onChange({ ...current, skin }); setStep(step === 'base-color' ? 'shape' : 'extras'); }} className={cn('flex min-h-12 min-w-0 items-center justify-center rounded-full', FOCUS)}>
        <span className={cn('size-8 rounded-full', current.skin === skin && 'ring-2 ring-[#7953de] ring-offset-2')} style={{ backgroundColor: DOODLE_COLOR_INFO[skin][2] }} />
      </button>)}
    </div>}

    {step === 'extras' && <>
      <div role="group" aria-label={label('配饰，可多选', 'Accessories, select multiple')} className="mt-3 grid w-full grid-cols-6 gap-0.5">
        {HERMES_PLAYFUL_DOODADS.map((id) => <button key={id} type="button" aria-label={DOODLE_PART_LABELS[id][zh ? 0 : 1]} aria-pressed={parts.includes(id)}
          onClick={() => onChange(toggleHermesDoodad(current, id))} className={cn('relative flex aspect-square min-h-11 min-w-0 items-center justify-center rounded-full p-2 transition-colors hover:bg-[#f8f5ff]', parts.includes(id) && 'bg-[#f5f0ff]', FOCUS)}>
          <img src={`${PLUSH_ROOT}/${PLUSH_OUTFITS[id]}.webp`} alt="" draggable={false} className="pointer-events-none max-h-9 w-full object-contain" />
          {parts.includes(id) && <span className="absolute right-0 top-0 flex size-3.5 items-center justify-center rounded-full bg-[#7950df] text-white"><Check size={10} strokeWidth={3} /></span>}
        </button>)}
        <button ref={drawingButton} type="button" aria-label={label('自己画', 'Draw your own')} aria-pressed={Boolean(current.drawing?.length)}
          onClick={() => (current.drawing?.length ? onChange({ ...current, drawing: [] }) : setDrawingOpen(true))}
          className={cn('relative flex aspect-square min-h-11 flex-col items-center justify-center gap-0.5 rounded-full text-[#7950df] hover:bg-[#f8f5ff]', current.drawing?.length && 'bg-[#f5f0ff]', FOCUS)}><Pencil size={22} /><span className="text-[10px]">{label('自己画', 'Draw')}</span>{current.drawing?.length ? <span className="absolute right-0 top-0 flex size-3.5 items-center justify-center rounded-full bg-[#7950df] text-white"><Check size={10} strokeWidth={3} /></span> : null}</button>
        <button type="button" aria-label={label('全部取下', 'Remove all accessories')} onClick={() => onChange({ ...current, doodads: [], drawing: [] })} className={cn('flex aspect-square min-h-11 items-center justify-center rounded-full text-[#b4adbf] hover:bg-[#f8f5ff]', FOCUS)}><Ban size={24} /></button>
      </div>
      <p className="mt-1 text-xs text-[#888094]">{label('再点一次，就能取下', 'Tap again to take it off')}</p>
      <button type="button" onClick={() => setStep('done')} className={cn('mt-3 min-h-11 w-full rounded-xl bg-[#7450dc] px-5 text-sm font-semibold text-white transition-colors hover:bg-[#6440cb]', FOCUS)}>{label('完成', 'Done')}</button>
    </>}

    {step === 'done' ? <div className="mt-3 flex flex-wrap items-center justify-center gap-4">
      <button type="button" onClick={() => setStep('base-color')} className={cn('min-h-11 rounded-md text-sm font-medium text-[#7050d9]', FOCUS)}>{label('返回自己搭配', 'Customize again')}</button>
      <button type="button" onClick={shuffle} className={cn('flex min-h-11 items-center gap-1 rounded-md text-xs text-[#777184]', FOCUS)}><Shuffle size={13} />{label('随机', 'Shuffle')}</button>
    </div> : <button type="button" onClick={() => { shuffle(); setStep('done'); }} className={cn('mt-2 flex min-h-11 items-center gap-1 rounded-md text-xs text-[#777184]', FOCUS)}><RefreshCw size={13} />{label('随机样式', 'Random look')}</button>}
  </section>;
}

export function AgentDressupStudio({ value, onChange, onBack, onConfirm, className }: {
  value: HermesAppearance; onChange: (next: HermesAppearance) => void; onBack: () => void;
  onConfirm: (next: HermesAppearance) => void; className?: string;
}) {
  const zh = useCurrentLocale().startsWith('zh');
  const label = (cnLabel: string, enLabel: string) => zh ? cnLabel : enLabel;
  const current = asDoodleAppearance(value);
  const [reaction, setReaction] = useState(0);
  const [drawingOpen, setDrawingOpen] = useState(false);
  const drawingButton = useRef<HTMLButtonElement>(null);
  const wasDrawing = useRef(false);
  useEffect(() => {
    if (wasDrawing.current && !drawingOpen) drawingButton.current?.focus();
    wasDrawing.current = drawingOpen;
  }, [drawingOpen]);
  const parts = current.doodads ?? [];
  const randomize = () => onChange(rollHermesLook(current, true));
  if (drawingOpen) return <HermesDrawingEditor appearance={current} zh={zh} onCancel={() => setDrawingOpen(false)} onConfirm={(drawing) => { onChange({ ...current, drawing }); setDrawingOpen(false); }} />;
  return <section aria-label={label('Hermes 形象选择', 'Customize Hermes')} className={cn('mx-auto w-full max-w-[560px] bg-white px-4 pb-5 pt-3 text-[#292638] sm:px-7 sm:pt-4', className)}>
    <header className="flex h-11 items-center justify-between gap-2 text-sm">
      <button type="button" onClick={onBack} className={cn('flex min-h-11 items-center gap-1 rounded-md text-[#6c677d]', FOCUS)}><ArrowLeft size={17} />{label('返回创建', 'Back')}</button>
      <span className="text-sm font-medium text-[#a88ae7]">LightVela</span>
      <button type="button" onClick={randomize} className={cn('flex min-h-11 items-center gap-1.5 rounded-md text-[#7550dc]', FOCUS)}><Shuffle size={17} />{label('随机', 'Shuffle')}</button>
    </header>
    <div className="mt-4 text-center">
      <h2 className="text-balance text-2xl font-semibold">{label('捏一个你的搭档', 'Make a little companion')}</h2>
      <p className="mt-2 text-sm text-[#847d97]">{label('换个形状，加一点个性。', 'A little shape. A lot of personality.')}</p>
    </div>
    <div className="mt-4 flex min-h-[286px] items-center justify-center py-2 sm:min-h-[316px]">
      <button type="button" onClick={() => setReaction((n) => n + 1)} aria-label={label('和 Hermes 打招呼', 'Say hello to Hermes')}
        className={cn('rounded-full', FOCUS)}><HermesPlushAvatar appearance={current} size={300} alive reaction={reaction} className="max-sm:!size-[270px]" /></button>
    </div>
    <div className="space-y-3">
      <fieldset className="flex min-w-0 items-center gap-2">
        <legend className="sr-only">{label('形状', 'Shape')}</legend><span aria-hidden="true" className="w-10 shrink-0 text-xs font-medium text-[#777087] sm:w-12 sm:text-sm">{label('形状', 'Shape')}</span>
        <div className="grid min-w-0 flex-1 grid-cols-5 gap-1">
          {HERMES_DOODLE_SHAPES.map((shape) => <button key={shape} type="button" aria-label={DOODLE_SHAPE_LABELS[shape][zh ? 0 : 1]} aria-pressed={current.shape === shape}
            onClick={() => onChange({ ...current, shape })} className={cn('group flex min-w-0 flex-col items-center rounded-md pb-1 text-xs text-[#777087]', FOCUS)}>
            <span className={cn('flex aspect-square w-full max-w-[78px] items-center justify-center rounded-full transition-colors group-hover:bg-[#f8f5ff]', current.shape === shape && 'bg-[#f4efff]')}>
              <HermesPlushAvatar appearance={{ ...current, shape, doodads: [], expression: 'open', drawing: [] }} size={76} className="!size-full" />
            </span>
            <span aria-hidden="true" className={cn('mt-1 size-1 rounded-full', current.shape === shape ? 'bg-[#7450d9]' : 'bg-transparent')} />
          </button>)}
        </div>
      </fieldset>
      <fieldset className="flex min-w-0 items-center gap-2">
        <legend className="sr-only">{label('颜色', 'Color')}</legend><span aria-hidden="true" className="w-10 shrink-0 text-xs font-medium text-[#777087] sm:w-12 sm:text-sm">{label('颜色', 'Color')}</span>
        <div className="grid min-w-0 flex-1 grid-cols-6 gap-0.5">
          {HERMES_DOODLE_COLORS.map((skin) => <button type="button" key={skin} aria-label={DOODLE_COLOR_INFO[skin][zh ? 0 : 1]} aria-pressed={current.skin === skin}
            onClick={() => onChange({ ...current, skin })} className={cn('flex min-h-11 min-w-0 items-center justify-center rounded-full', FOCUS)}>
            <span className={cn('size-7 rounded-full sm:size-8', current.skin === skin && 'ring-2 ring-[#7953de] ring-offset-4')} style={{ backgroundColor: DOODLE_COLOR_INFO[skin][2] }} />
          </button>)}
        </div>
      </fieldset>
      <fieldset className="flex min-w-0 items-center gap-2">
        <legend className="sr-only">{label('配饰，可多选', 'Accessories, select multiple')}</legend>
        <span aria-hidden="true" className="w-10 shrink-0 text-xs font-medium text-[#777087] sm:w-12 sm:text-sm">{label('配饰', 'Extras')}<span className="mt-1 block text-[10px] font-normal">{label('可多选', 'Mix them')}</span></span>
        <div className="grid min-w-0 flex-1 grid-cols-6 gap-0.5">
          {HERMES_PLAYFUL_DOODADS.map((id) => <button key={id} type="button" aria-label={DOODLE_PART_LABELS[id][zh ? 0 : 1]} aria-pressed={parts.includes(id)}
            onClick={() => onChange(toggleHermesDoodad(current, id))} className={cn('relative flex aspect-square min-h-11 min-w-0 items-center justify-center rounded-full p-2 transition-colors hover:bg-[#f8f5ff]', parts.includes(id) && 'bg-[#f5f0ff]', FOCUS)}>
            <img src={`${PLUSH_ROOT}/${PLUSH_OUTFITS[id]}.webp`} alt="" draggable={false} className="pointer-events-none max-h-9 w-full object-contain" />
            {parts.includes(id) && <span className="absolute right-0 top-0 flex size-3.5 items-center justify-center rounded-full bg-[#7950df] text-white"><Check size={10} strokeWidth={3} /></span>}
          </button>)}
          <button ref={drawingButton} type="button" aria-label={label('自己画', 'Draw your own')} aria-pressed={Boolean(current.drawing?.length)}
            onClick={() => (current.drawing?.length ? onChange({ ...current, drawing: [] }) : setDrawingOpen(true))}
            className={cn('relative flex aspect-square min-h-11 flex-col items-center justify-center gap-0.5 rounded-full text-[#7950df] hover:bg-[#f8f5ff]', current.drawing?.length && 'bg-[#f5f0ff]', FOCUS)}><Pencil size={23} /><span className="text-[10px]">{label('自己画', 'Draw')}</span>{current.drawing?.length ? <span className="absolute right-0 top-0 flex size-3.5 items-center justify-center rounded-full bg-[#7950df] text-white"><Check size={10} strokeWidth={3} /></span> : null}</button>
          <button type="button" aria-label={label('全部取下', 'Remove all accessories')} onClick={() => onChange({ ...current, doodads: [], drawing: [] })} className={cn('flex aspect-square min-h-11 items-center justify-center rounded-full text-[#b4adbf] hover:bg-[#f8f5ff]', FOCUS)}><Ban size={25} /></button>
        </div>
      </fieldset>
    </div>
    <p className="mt-2 text-center text-xs text-[#888094]">{label('再点一次，就能取下', 'Tap again to take it off')}</p>
    <footer className="sticky bottom-0 z-10 mt-4 bg-white pb-[max(.5rem,env(safe-area-inset-bottom))] pt-2">
      <button type="button" onClick={() => onConfirm(current)} className={cn('min-h-12 w-full rounded-xl bg-[#7450dc] px-5 text-sm font-semibold text-white transition-colors hover:bg-[#6440cb]', FOCUS)}>{label('就用这个', 'This is the one')}</button>
    </footer>
  </section>;
}

export { DEFAULT_HERMES_APPEARANCE };
