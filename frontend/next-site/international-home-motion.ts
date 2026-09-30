import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { mountFeaturePreviews } from './international-home-feature-previews';
import { mountStageMotion } from './international-home-stage-motion';

const activeRoots = new WeakMap<HTMLElement, () => void>();
const HOME_DISPOSE_EVENT = 'lightvela-home-dispose';

export function mountInternationalHomeMotion(root: HTMLElement): () => void {
  activeRoots.get(root)?.();
  gsap.registerPlugin(ScrollTrigger);

  const media = gsap.matchMedia();
  const originalReady = root.getAttribute('data-home-motion-ready');
  let disposed = false;

  media.add({
    desktop: '(min-width: 900px)',
    mobile: '(max-width: 899px)',
    reduce: '(prefers-reduced-motion: reduce)',
    hover: '(hover: hover) and (pointer: fine)',
  }, (context) => {
    const { desktop, reduce, hover } = context.conditions!;
    root.dataset.homeMotionReady = reduce ? 'reduced' : 'active';
    if (reduce) return;

    const select = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector);
    const running = new Set<gsap.core.Animation>();
    const pausedForVisibility = new Set<gsap.core.Animation>();
    const stops: Array<() => void> = [];
    const panelAnimations = new Map<HTMLElement, gsap.core.Tween>();
    let stopped = false;
    let refreshFrame = 0;
    let keyboardInput = false;

    function track<T extends gsap.core.Animation>(animation: T): T {
      running.add(animation);
      return animation;
    }

    function entrance(target: Element | null, trigger: Element | null, vars: gsap.TweenVars, delay = 0) {
      if (!target || !trigger) return;
      const timeline = track(gsap.timeline({
        defaults: { duration: desktop ? 0.46 : 0.28, ease: 'power2.out' },
        scrollTrigger: { trigger, start: 'top 90%', toggleActions: 'play none none none' },
      }));
      timeline.fromTo(target, {
        y: desktop ? 20 : 8,
        opacity: 0.25,
        ...vars,
      }, {
        x: 0, y: 0, opacity: 1, rotation: 0, rotationX: 0,
        duration: vars.duration ?? (desktop ? 0.46 : 0.28),
        transformPerspective: vars.transformPerspective ?? 0,
        transformOrigin: vars.transformOrigin ?? '50% 50%',
        immediateRender: false,
        clearProps: 'transform,transformOrigin,opacity,visibility',
      }, delay);
      return timeline;
    }

    if (desktop) {
      const cards = Array.from(root.querySelectorAll<HTMLElement>('.about__cards .wcard'));
      cards.sort((a, b) => {
        const first = a.getBoundingClientRect();
        const second = b.getBoundingClientRect();
        return Math.abs(first.top - second.top) > 8 ? first.top - second.top : first.left - second.left;
      });
      cards.forEach((card, index) => entrance(card, card, {
        y: 32, opacity: 0.3, duration: 0.65,
      }, (index % 3) * 0.09));
    } else {
      entrance(select('.about__cards'), select('.about__cards'), { y: 6, opacity: 0.8, duration: 0.24 });
    }

    stops.push(mountStageMotion(root, { desktop: Boolean(desktop), hover: Boolean(hover) }));
    stops.push(mountFeaturePreviews(root));

    const finishPanels = () => {
      panelAnimations.forEach((animation) => { animation.progress(1).kill(); });
      panelAnimations.clear();
    };
    const pointerInput = () => { keyboardInput = false; };
    const keyInput = () => { keyboardInput = true; finishPanels(); };
    root.addEventListener('pointerdown', pointerInput, true);
    root.addEventListener('pointerover', pointerInput, true);
    root.addEventListener('keydown', keyInput, true);

    context.add('changePanel', (event: Event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.type !== 'radio' || !input.checked) return;
      const scene = input.id.match(/^sc-(\d+)$/);
      const play = input.id.match(/^pl-(\d+)$/);
      if (!scene && !play) return;
      finishPanels();
      if (keyboardInput || document.hidden) return;
      const panel = select<HTMLElement>(scene ? `#scene-${scene[1]}` : `#${input.id.replace('pl-', 'play-')}`);
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) return;
      const targets = scene ? panel.querySelectorAll<HTMLElement>('.scene__split') : panel.querySelectorAll<HTMLElement>('.play__text, .play__screen');
      targets.forEach((target, index) => {
        const animation = gsap.fromTo(target, {
          x: desktop ? 44 : 16, y: desktop ? 12 : 0, opacity: 0.25,
          rotationY: desktop && target.matches('.play__screen') ? -12 : 0,
          scale: target.matches('.play__screen') ? 0.97 : 1,
          transformPerspective: 1000, transformOrigin: '0% 50%',
        }, {
          x: 0, y: 0, opacity: 1, rotationY: 0, scale: 1,
          transformPerspective: 1000, transformOrigin: '0% 50%',
          duration: 0.28, delay: index * 0.015, ease: 'power3.out', overwrite: 'auto',
          clearProps: 'transform,transformOrigin,opacity',
          onComplete: () => { panelAnimations.delete(target); },
        });
        panelAnimations.set(target, animation);
      });
      requestRefresh();
    });
    const changePanel = context.changePanel as (event: Event) => void;
    root.addEventListener('change', changePanel);

    function requestRefresh() {
      if (stopped || disposed || document.hidden || refreshFrame) return;
      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = 0;
        if (!stopped && !disposed && root.isConnected) ScrollTrigger.refresh();
      });
    }

    function visibilityChange() {
      if (document.hidden) {
        finishPanels();
        running.forEach((animation) => {
          if (animation.isActive()) { pausedForVisibility.add(animation); animation.pause(); }
        });
      } else {
        pausedForVisibility.forEach((animation) => { animation.resume(); });
        pausedForVisibility.clear();
        requestRefresh();
      }
    }

    root.addEventListener('load', requestRefresh, true);
    document.addEventListener('visibilitychange', visibilityChange);
    document.fonts?.ready.then(requestRefresh);
    requestRefresh();

    return () => {
      stopped = true;
      cancelAnimationFrame(refreshFrame);
      stops.forEach((stop) => stop());
      root.removeEventListener('change', changePanel);
      root.removeEventListener('pointerdown', pointerInput, true);
      root.removeEventListener('pointerover', pointerInput, true);
      root.removeEventListener('keydown', keyInput, true);
      root.removeEventListener('load', requestRefresh, true);
      document.removeEventListener('visibilitychange', visibilityChange);
      running.clear();
      panelAnimations.clear();
      pausedForVisibility.clear();
    };
  }, root);

  function dispose() {
    if (disposed) return;
    disposed = true;
    media.revert();
    document.removeEventListener(HOME_DISPOSE_EVENT, dispose);
    if (originalReady === null) root.removeAttribute('data-home-motion-ready');
    else root.setAttribute('data-home-motion-ready', originalReady);
    if (activeRoots.get(root) === dispose) activeRoots.delete(root);
  }

  activeRoots.set(root, dispose);
  document.addEventListener(HOME_DISPOSE_EVENT, dispose);
  return dispose;
}
