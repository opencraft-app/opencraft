import { moveRetainedView } from './retained-preview-placement';
import { animate, useMotionValue, useReducedMotion } from 'motion/react';
import { useLayoutEffect, useRef } from 'react';
import { PANEL_CONTINUOUS_SPRING_TRANSITION } from './use-panel-animation';

export interface BrowserComposerTransition { open: boolean; complete(): void }

/** One clock moves existing browser chrome and reveals the conversation below it.
 * Reversals keep the current progress/velocity; only the current flight can settle. */
export function useBrowserComposerMotion(
  dock: HTMLElement | null, controls: HTMLElement, switcher: HTMLElement,
  header: HTMLElement | null | undefined, footer: HTMLElement | null | undefined,
  transition?: BrowserComposerTransition,
) {
  const progress = useMotionValue(0);
  const reduced = useReducedMotion();
  const inheritedVelocity = useRef<number | undefined>(undefined);
  const latest = useRef(transition); latest.current = transition;
  useLayoutEffect(() => {
    if (!dock) return;
    const move = (node: HTMLElement, parent: HTMLElement) => {
      if (node.parentElement === parent) return;
      if (!moveRetainedView(parent, node)) parent.append(node);
    };
    move(controls, header ?? dock); move(switcher, footer ?? dock);
    const control = controls.firstElementChild as HTMLElement | null;
    const panel = header?.closest<HTMLElement>('.thread-composer-overlay__interactive');
    if (!header || !footer || !panel || !control || !transition) {
      progress.jump(0); control?.removeAttribute('data-composer-moving');
      control?.style.removeProperty('transform'); control?.style.removeProperty('width');
      return;
    }
    let live = true;
    const paint = () => {
      const p = Math.max(0, Math.min(1, progress.get()));
      const base = dock.getBoundingClientRect(), target = panel.getBoundingClientRect();
      const bar = header.getBoundingClientRect();
      const tab = switcher.firstElementChild?.getBoundingClientRect();
      const gap = Number.parseFloat(getComputedStyle(dock).columnGap) || 0;
      const closedWidth = Math.max(0, base.width - (tab?.width ?? 0) - gap);
      const distance = Math.max(0, base.bottom - bar.height - target.top);
      control.style.transform = p === 1 ? 'none' : `translateY(${distance * (1 - p)}px)`;
      control.style.width = `${closedWidth + (bar.width - closedWidth) * p}px`;
      control.dataset.composerMoving = p > 0 && p < 1 ? 'true' : 'false';
      panel.dataset.browserMoving = p > 0 && p < 1 ? 'true' : 'false';
      panel.style.clipPath = p === 1 ? 'none' : `inset(${distance * (1 - p)}px ${Math.max(0, target.width - closedWidth) * (1 - p)}px 0 0 round var(--radius-2xl))`;
      panel.style.setProperty('--browser-composer-progress', String(p));
    };
    paint();
    const unsubscribe = progress.on('change', paint);
    const observer = new ResizeObserver(paint); observer.observe(dock); observer.observe(panel);
    const target = transition.open ? 1 : 0;
    const complete = () => { if (live) latest.current?.complete(); };
    let playback: ReturnType<typeof animate> | undefined;
    if (reduced) { progress.jump(target); paint(); complete(); }
    else playback = animate(progress, [progress.get(), target], { ...PANEL_CONTINUOUS_SPRING_TRANSITION, velocity: inheritedVelocity.current ?? progress.getVelocity(), onComplete: complete });
    inheritedVelocity.current = undefined;
    return () => {
      live = false;
      // Motion.stop() samples wall-clock time, which can be ahead of the last
      // painted frame. Carry the visible value/velocity across the reversal.
      const held = progress.get(), velocity = progress.getVelocity();
      unsubscribe(); observer.disconnect(); playback?.stop();
      progress.jump(held); inheritedVelocity.current = velocity;
      delete panel.dataset.browserMoving;
      panel.style.removeProperty('clip-path'); panel.style.removeProperty('--browser-composer-progress');
    };
  }, [dock, controls, switcher, header, footer, transition?.open, reduced, progress]);
}
