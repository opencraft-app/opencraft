import { gsap } from 'gsap';
import { mountMascotLife } from './international-home-mascot-life';
import { mountHomeScrollCast } from './home-scroll-cast-loader';
import { mountStageMotion } from './international-home-stage-motion';

const activeRoots = new WeakMap<HTMLElement, () => void>();
const HOME_DISPOSE_EVENT = 'lightvela-home-dispose';

/** Preserve domestic CSS entrances; GSAP owns the later stage and mascot motion. */
export function mountDomesticHomeMascotMotion(root: HTMLElement): () => void {
  activeRoots.get(root)?.();
  const stopFriends = mountHomeScrollCast(root);
  const media = gsap.matchMedia();
  let disposed = false;
  media.add({
    desktop: '(min-width: 900px)',
    mobile: '(max-width: 899px)',
    reduce: '(prefers-reduced-motion: reduce)',
    hover: '(hover: hover) and (pointer: fine)',
  }, (context) => {
    const { desktop, reduce, hover } = context.conditions!;
    if (reduce) return;
    const options = { desktop: Boolean(desktop), hover: Boolean(hover) };
    const stopLife = mountMascotLife(root, options);
    const stopStage = mountStageMotion(root, { ...options, preserveHeroCss: true, mascotLifeMounted: true });
    return () => { stopStage(); stopLife(); };
  }, root);
  function dispose() {
    if (disposed) return;
    disposed = true;
    media.revert();
    stopFriends();
    document.removeEventListener(HOME_DISPOSE_EVENT, dispose);
    if (activeRoots.get(root) === dispose) activeRoots.delete(root);
  }
  document.addEventListener(HOME_DISPOSE_EVENT, dispose);
  activeRoots.set(root, dispose);
  return dispose;
}
