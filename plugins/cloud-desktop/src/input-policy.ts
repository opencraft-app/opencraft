export interface Point { readonly x: number; readonly y: number }
export interface Frame extends Point { readonly width: number; readonly height: number }
export interface ViewTransform { readonly scale: number; readonly x: number; readonly y: number }
export const fitView: ViewTransform = { scale: 1, x: 0, y: 0 };

/** Focal offset is relative to the untransformed canvas center, not its bars. */
export function zoomAround(view: ViewTransform, focalOffset: Point, scale: number): ViewTransform {
  const next = Math.min(4, Math.max(1, scale)), ratio = next / view.scale;
  return { scale: next, x: view.x * ratio + focalOffset.x * (1 - ratio),
    y: view.y * ratio + focalOffset.y * (1 - ratio) };
}

/** Actual displayed media bounds include local zoom/pan; bars are not pixels. */
export function framebufferPoint(point: Point, frame: Frame, width: number, height: number,
  clamp = false): Point | null {
  if (![point.x, point.y, frame.x, frame.y, frame.width, frame.height, width, height].every(Number.isFinite)
    || frame.width <= 0 || frame.height <= 0 || width <= 0 || height <= 0) return null;
  const x = (point.x - frame.x) / frame.width, y = (point.y - frame.y) / frame.height;
  if (!clamp && (x < 0 || y < 0 || x >= 1 || y >= 1)) return null;
  return { x: Math.min(width - 1, Math.max(0, Math.floor(x * width))),
    y: Math.min(height - 1, Math.max(0, Math.floor(y * height))) };
}

export function constrainView(view: ViewTransform, media: { width: number; height: number },
  viewport: { width: number; height: number }): ViewTransform {
  const scale = Math.min(4, Math.max(1, view.scale));
  const x = Math.max(0, (media.width * scale - viewport.width) / 2);
  const y = Math.max(0, (media.height * scale - viewport.height) / 2);
  return { scale, x: Math.min(x, Math.max(-x, view.x)), y: Math.min(y, Math.max(-y, view.y)) };
}

export class DesktopScrollPolicy {
  private x = 0;
  private y = 0;
  private lastInput = -Infinity;
  private lastStep = -Infinity;
  reset(): void { this.x = this.y = 0; this.lastInput = this.lastStep = -Infinity; }
  consume(x: number, y: number, mode: number, now: number): readonly number[] {
    if (![x, y, now].every(Number.isFinite)) return [];
    if (now - this.lastInput > 200) this.x = this.y = 0;
    this.lastInput = now;
    const unit = mode === 0 ? 1 : 19;
    const merge = (old: number, delta: number) => Math.min(40, Math.max(-40,
      (old * delta < 0 ? 0 : old) + Math.min(10, Math.max(-10, delta * unit))));
    this.x = merge(this.x, x); this.y = merge(this.y, y);
    if (now - this.lastStep < 100) return [];
    const steps: number[] = [];
    if (Math.abs(this.x) >= 10) { steps.push(this.x < 0 ? 32 : 64); this.x = 0; }
    if (Math.abs(this.y) >= 10) { steps.push(this.y < 0 ? 8 : 16); this.y = 0; }
    if (steps.length) this.lastStep = now;
    return steps;
  }
}

export type TouchIntent = "undecided" | "scroll" | "zoom";
export function classifyTwoFinger(distanceChange: number, movement: Point): TouchIntent {
  if (Math.abs(distanceChange) >= 8) return "zoom";
  if (Math.hypot(movement.x, movement.y) >= 8) return "scroll";
  return "undecided";
}
