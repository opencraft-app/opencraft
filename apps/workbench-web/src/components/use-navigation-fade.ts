import { animate, useMotionValue, useReducedMotion, type MotionValue } from 'motion/react';
import { useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import type { NavigationPresentation } from '../runtime/workbench-navigation-transaction';
import { CONVERSATION_FADE_TRANSITION, CONVERSATION_DEPARTURE_TRANSITION } from './use-panel-animation';

const noSubscribe = () => () => {};
const noTransition = () => null;

/** One visual owner; navigation alone owns request identity, commit and outcome. */
export function useNavigationFade(
  navigation: NavigationPresentation | undefined,
  root: RefObject<HTMLElement | null>, overlay: HTMLElement | null, layoutTick: MotionValue<number>,
  departureProgress?: MotionValue<number>,
) {
  const transition = useSyncExternalStore(navigation?.subscribeTransition ?? noSubscribe, navigation?.getTransition ?? noTransition);
  const opacity = useMotionValue(1);
  const reduced = useReducedMotion() === true;
  const latestReduced = useRef(reduced); latestReduced.current = reduced;
  const latestDepartureProgress = useRef(departureProgress); latestDepartureProgress.current = departureProgress;
  const stopProgress = useRef<(() => void) | undefined>(undefined);
  const playback = useRef<ReturnType<typeof animate> | null>(null);
  const releaseDeparture = useRef<(() => void) | undefined>(undefined);
  const generation = useRef(0);
  useLayoutEffect(() => {
    const paint = () => {
      root.current?.style.setProperty('--navigation-content-opacity', String(opacity.get()));
      if (overlay) overlay.style.opacity = String(opacity.get());
      layoutTick.set(layoutTick.get() + 1);
    };
    paint(); const stop = opacity.on('change', paint);
    return () => { stop(); root.current?.style.removeProperty('--navigation-content-opacity'); overlay?.style.removeProperty('opacity'); };
  }, [root, overlay, opacity, layoutTick]);
  useLayoutEffect(() => {
    if (!navigation) return;
    const detach = navigation.attachDeparture((_id, prepared) => new Promise<void>(resolve => {
      ++generation.current; playback.current?.stop(); stopProgress.current?.(); stopProgress.current = undefined;
      releaseDeparture.current?.(); releaseDeparture.current = resolve;
      const receipt = generation.current;
      const complete = () => {
        if (generation.current !== receipt) return;
        releaseDeparture.current = undefined; resolve();
      };
      if (latestReduced.current || document.hidden) { complete(); }
      else {
        const drawerProgress = latestDepartureProgress.current;
        const startProgress = drawerProgress?.get() ?? 0;
        if (drawerProgress && startProgress > 0.001) {
          // Consume the drawer's actual travel; no second clock or minimum dwell.
          stopProgress.current = drawerProgress.on('change', value => {
            if (generation.current === receipt)
              opacity.set(Math.min(opacity.get(), Math.max(0, value / startProgress)));
          });
        } else playback.current = animate(opacity, 0, CONVERSATION_DEPARTURE_TRANSITION);
        void prepared.then(() => {
          if (generation.current !== receipt) return;
          playback.current?.stop(); stopProgress.current?.(); stopProgress.current = undefined;
          // Preparation hands the allocation to the next React layout commit.
          // Never insert a fully transparent frame between two readable Views.
          complete();
        });
      }
    }));
    return () => {
      detach(); ++generation.current; playback.current?.stop(); stopProgress.current?.(); stopProgress.current = undefined;
      releaseDeparture.current?.(); releaseDeparture.current = undefined;
      opacity.jump(1);
    };
  }, [navigation, opacity]);
  useLayoutEffect(() => {
    if (!transition || navigation?.getTransition() !== transition || transition.phase === 'preparing' || transition.phase === 'committed') return;
    ++generation.current; playback.current?.stop(); stopProgress.current?.(); stopProgress.current = undefined;
    releaseDeparture.current?.(); releaseDeparture.current = undefined;
    const from = opacity.get();
    // Layout readiness releases arrival; it never restarts departure or hides
    // content that is already readable.
    opacity.jump(reduced ? 1 : from);
    if (!reduced && from < 1) playback.current = animate(opacity, 1, {
      ...CONVERSATION_FADE_TRANSITION, duration: CONVERSATION_FADE_TRANSITION.duration * (1 - from),
    });
  }, [navigation, transition, reduced, opacity]);
  useLayoutEffect(() => {
    if (!reduced) return;
    ++generation.current; playback.current?.stop(); stopProgress.current?.(); stopProgress.current = undefined;
    opacity.jump(1);
    releaseDeparture.current?.(); releaseDeparture.current = undefined;
  }, [reduced, transition?.phase, opacity]);
  useLayoutEffect(() => {
    const hidden = () => {
      if (!document.hidden) return;
      ++generation.current; playback.current?.stop(); stopProgress.current?.(); stopProgress.current = undefined;
      opacity.jump(1);
      releaseDeparture.current?.(); releaseDeparture.current = undefined;
    };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [navigation, opacity]);
  return { transition, blocked: transition?.phase === 'preparing' || transition?.phase === 'committed' };
}
