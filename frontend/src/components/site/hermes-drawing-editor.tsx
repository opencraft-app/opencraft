'use client';

import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { ArrowLeft, Check, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HermesPlushAvatar } from '@/components/site/hermes-plush-avatar';
import { HermesDrawingLayer } from '@/components/site/hermes-drawing-layer';
import { HERMES_DRAWING_LIMITS, type HermesAppearance, type HermesDrawingStroke } from '@/lib/hermes-appearance';
import { useT } from '@/i18n/t';
import { cn } from '@/lib/utils';

const INKS = [
  ['#373044', '墨黑', 'Ink'], ['#8B5CF6', '紫色', 'Violet'], ['#F47B84', '珊瑚', 'Coral'],
  ['#3C9B82', '青绿', 'Teal'], ['#FFFFFF', '白色', 'White'],
] as const;
const copyDrawing = (strokes: readonly HermesDrawingStroke[]) => strokes.map((stroke) => ({ ...stroke, points: stroke.points.map(([x, y]): [number, number] => [x, y]) }));

export function HermesDrawingEditor({ appearance, onConfirm, onCancel }: {
  appearance: HermesAppearance; zh: boolean;
  onConfirm: (strokes: HermesDrawingStroke[]) => void; onCancel: () => void;
}) {
  const t = useT();
  const instructionsId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  const [draft, setDraft] = useState(() => copyDrawing(appearance.drawing ?? []));
  const draftRef = useRef(draft);
  const history = useRef<HermesDrawingStroke[][]>([]);
  const active = useRef<{ pointerId: number; index: number } | null>(null);
  const submitted = useRef(false);
  const [drawing, setDrawing] = useState(false);
  const [color, setColor] = useState<string>(INKS[0][0]);
  const [width, setWidth] = useState(8);
  const [limitMessage, setLimitMessage] = useState('');
  const update = (next: HermesDrawingStroke[]) => { draftRef.current = next; setDraft(next); };
  const fullMessage = t('画纸快满了，撤销几笔就能继续。');
  const point = (event: PointerEvent<HTMLDivElement>): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect();
    const bounded = (value: number) => Math.max(0, Math.min(HERMES_DRAWING_LIMITS.coordinateMax, Math.round(value)));
    return [bounded((event.clientX - rect.left) / Math.max(1, rect.width) * 1000), bounded((event.clientY - rect.top) / Math.max(1, rect.height) * 1000)];
  };
  const accepts = (next: HermesDrawingStroke[]) => next.reduce((sum, stroke) => sum + stroke.points.length, 0) <= HERMES_DRAWING_LIMITS.maxTotalPoints
    && JSON.stringify(next).length <= HERMES_DRAWING_LIMITS.maxSerializedLength;
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (submitted.current || active.current || event.isPrimary === false || event.button !== 0) return;
    const current = draftRef.current;
    const next = [...current, { color, width, points: [point(event)] }];
    if (current.length >= HERMES_DRAWING_LIMITS.maxStrokes || !accepts(next)) { setLimitMessage(fullMessage); return; }
    event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId);
    history.current.push(current); active.current = { pointerId: event.pointerId, index: current.length };
    setDrawing(true); setLimitMessage(''); update(next);
  };
  const append = (event: PointerEvent<HTMLDivElement>) => {
    if (!active.current || active.current.pointerId !== event.pointerId) return;
    const { index } = active.current;
    const current = draftRef.current;
    const stroke = current[index];
    if (!stroke) return;
    const nextPoint = point(event);
    const previous = stroke.points.at(-1);
    if (!previous) return;
    if (nextPoint[0] === previous[0] && nextPoint[1] === previous[1]) return;
    if (stroke.points.length >= HERMES_DRAWING_LIMITS.maxPointsPerStroke) {
      setLimitMessage(t('这一笔画满了，松开后可以再画一笔。')); return;
    }
    const next = current.map((item, i) => i === index ? { ...item, points: [...item.points, nextPoint] } : item);
    if (!accepts(next)) { setLimitMessage(fullMessage); return; }
    update(next);
  };
  const finish = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (!active.current || active.current.pointerId !== event.pointerId) return;
    if (!cancelled) append(event);
    active.current = null; setDrawing(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const undo = () => { const previous = history.current.pop() ?? draftRef.current.slice(0, -1); update(previous); setLimitMessage(''); };
  const clear = () => { if (draftRef.current.length) { history.current.push(draftRef.current); update([]); setLimitMessage(''); } };
  const done = () => {
    if (submitted.current || active.current) return;
    submitted.current = true; onConfirm(copyDrawing(draftRef.current));
  };
  return <section aria-label={t('自由画')} className="mx-auto w-full max-w-[360px] space-y-4 px-3 pb-4 text-[#373044]">
    <header className="flex items-center justify-between gap-3">
      <Button type="button" variant="ghost" size="sm" onClick={onCancel} className="gap-1.5"><ArrowLeft size={16} aria-hidden="true" />{t('取消')}</Button>
      <h2 ref={headingRef} tabIndex={-1} className="outline-none text-balance text-base font-semibold">{t('自己画')}</h2>
      <span className="w-12" aria-hidden="true" />
    </header>
    <p id={instructionsId} className="text-center text-pretty text-sm text-[#777185]">{t('直接在小伙伴身上画，画错也能撤销。')}</p>
    <div role="group" aria-label={t('自由绘画画布')} aria-describedby={instructionsId} data-testid="hermes-drawing-canvas"
      className="relative mx-auto aspect-square w-full max-w-[300px] touch-none cursor-crosshair select-none overflow-hidden rounded-3xl bg-[#FAF8FE]"
      onPointerDown={start} onPointerMove={append} onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)} onLostPointerCapture={(event) => finish(event, true)}>
      <div className="pointer-events-none absolute inset-0"><HermesPlushAvatar appearance={{ ...appearance, drawing: [] }} size={300} alive={false} className="!size-full" /></div>
      <HermesDrawingLayer strokes={draft} />
    </div>
    <div role="group" aria-label={t('画笔颜色')} className="flex items-center justify-center gap-2">
      {INKS.map(([ink, cnName]) => <Button key={ink} type="button" variant="ghost" size="default" aria-label={t(cnName)} aria-pressed={color === ink}
        onClick={() => setColor(ink)} className={cn('size-11 rounded-full p-2', color === ink && 'ring-2 ring-[#8B5CF6] ring-offset-2')}>
        <span className="size-full rounded-full border border-black/10" style={{ backgroundColor: ink }} />
      </Button>)}
    </div>
    <div className="flex flex-wrap items-center justify-center gap-1">
      <div role="group" aria-label={t('画笔粗细')} className="mr-2 flex rounded-full bg-[#F4F1F8] p-1">
        {[8, 18].map((value) => <Button key={value} type="button" variant="ghost" size="sm" aria-pressed={width === value} onClick={() => setWidth(value)}
          className={cn('h-11 rounded-full px-3 text-xs', width === value && 'bg-white shadow-sm')}>{value === 8 ? (t('细笔')) : (t('粗笔'))}</Button>)}
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={undo} disabled={drawing || (history.current.length === 0 && draft.length === 0)} className="gap-1 text-xs"><Undo2 size={15} aria-hidden="true" />{t('撤销')}</Button>
      <Button type="button" variant="ghost" size="sm" onClick={clear} disabled={drawing || draft.length === 0} className="gap-1 text-xs"><Trash2 size={15} aria-hidden="true" />{t('清空')}</Button>
    </div>
    <p role="status" className="min-h-5 text-center text-pretty text-xs text-[#777185]">{limitMessage}</p>
    <Button type="button" onClick={done} disabled={drawing} className="h-11 w-full gap-2 rounded-full"><Check size={17} aria-hidden="true" />{t('完成涂鸦')}</Button>
  </section>;
}

function __i18nExtractInk(t: (value: string) => string) {
  t('墨黑');
  t('紫色');
  t('珊瑚');
  t('青绿');
  t('白色');
}
void __i18nExtractInk;
