import type { HermesDrawingStroke } from '@/lib/hermes-appearance';
import { cn } from '@/lib/utils';

/** Real user-created drawing data, shared by the editor and saved avatars. */
export function HermesDrawingLayer({ strokes, className }: { strokes: readonly HermesDrawingStroke[]; className?: string }) {
  return <svg viewBox="0 0 1000 1000" aria-hidden="true" focusable="false" data-testid="hermes-drawing-layer"
    className={cn('pointer-events-none absolute inset-0 size-full overflow-hidden', className)}>
    {strokes.map((stroke, index) => {
      const first = stroke.points[0];
      if (!first) return null;
      return stroke.points.length === 1
      ? <circle key={index} cx={first[0]} cy={first[1]} r={stroke.width / 2} fill={stroke.color} />
      : <path key={index} d={stroke.points.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ')}
        fill="none" stroke={stroke.color} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" />;
    })}
  </svg>;
}
