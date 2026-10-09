'use client';

import { useEffect, useRef } from 'react';

const MOTION_QUERY = '(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)';
const ASSET_ROOT = '/lightvela-intl-home/assets';
const IDLE_FADE_DELAY_MS = 1200;

export function HomePointerMascot() {
  const mascotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mascot = mascotRef.current;
    if (!mascot) return;

    const motion = window.matchMedia(MOTION_QUERY);
    const hero = document.querySelector<HTMLElement>('#lightvela-intl-home .hero');
    let heroBounds = hero?.getBoundingClientRect();
    const footer = document.querySelector<HTMLElement>('#lightvela-intl-home .foot');
    let footerBounds = footer?.getBoundingClientRect();
    let pointerX = 0;
    let pointerY = 0;
    let currentX = 0;
    let currentY = 0;
    let visible = false;
    let hasPointer = false;
    let frame = 0;
    let previousTime = 0;
    let winkTimer = 0;
    let openTimer = 0;
    let idleTimer = 0;

    function stopWink() {
      window.clearTimeout(winkTimer);
      window.clearTimeout(openTimer);
      mascot?.classList.remove('is-winking');
    }

    function scheduleWink() {
      winkTimer = window.setTimeout(() => {
        if (!visible) return;
        mascot?.classList.add('is-winking');
        openTimer = window.setTimeout(() => {
          mascot?.classList.remove('is-winking');
          if (visible) scheduleWink();
        }, 240);
      }, 3200 + Math.random() * 1800);
    }

    function hide() {
      if (!visible) return;
      visible = false;
      window.clearTimeout(idleTimer);
      mascot?.classList.remove('is-visible', 'is-idle');
      stopWink();
      window.cancelAnimationFrame(frame);
      frame = 0;
      previousTime = 0;
    }

    function animate(time: number) {
      const elapsed = previousTime ? Math.min(time - previousTime, 64) : 16;
      previousTime = time;
      const ease = 1 - Math.exp(-elapsed / 220);
      currentX += (pointerX - currentX) * ease;
      currentY += (pointerY - currentY) * ease;
      mascot!.style.transform = `translate3d(${currentX + 18}px, ${currentY + 18}px, 0)`;

      if (Math.hypot(pointerX - currentX, pointerY - currentY) > 0.5) {
        frame = window.requestAnimationFrame(animate);
      } else {
        frame = 0;
        previousTime = 0;
      }
    }

    function overExcludedSection(x: number, y: number) {
      if (!heroBounds) return true;
      return [heroBounds, footerBounds].some(bounds => bounds &&
        x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom);
    }

    function refreshHeroBounds() {
      heroBounds = hero?.getBoundingClientRect();
      footerBounds = footer?.getBoundingClientRect();
      updateVisibility();
    }

    function updateVisibility() {
      if (!hasPointer || !motion.matches || document.hidden || overExcludedSection(pointerX, pointerY)) {
        hide();
        return;
      }
      if (!visible) {
        visible = true;
        currentX = pointerX;
        currentY = pointerY;
        mascot!.style.transform = `translate3d(${currentX + 18}px, ${currentY + 18}px, 0)`;
        mascot?.classList.add('is-visible');
        scheduleWink();
      }
      if (!frame) frame = window.requestAnimationFrame(animate);
    }

    function onPointerMove(event: PointerEvent) {
      if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
      hasPointer = true;
      pointerX = event.clientX;
      pointerY = event.clientY;
      updateVisibility();
      if (!visible) return;
      if (mascot?.classList.contains('is-idle')) {
        mascot.classList.remove('is-idle');
        scheduleWink();
      }
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        mascot?.classList.add('is-idle');
        stopWink();
      }, IDLE_FADE_DELAY_MS);
    }

    function onPointerOut(event: PointerEvent) {
      if (!event.relatedTarget) hide();
    }

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerout', onPointerOut);
    document.addEventListener('visibilitychange', updateVisibility);
    window.addEventListener('scroll', refreshHeroBounds, { passive: true });
    window.addEventListener('resize', refreshHeroBounds);
    motion.addEventListener('change', updateVisibility);
    const heroObserver = hero && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(refreshHeroBounds)
      : null;
    if (hero && heroObserver) heroObserver.observe(hero);
    if (footer && heroObserver) heroObserver.observe(footer);

    return () => {
      hide();
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerout', onPointerOut);
      document.removeEventListener('visibilitychange', updateVisibility);
      window.removeEventListener('scroll', refreshHeroBounds);
      window.removeEventListener('resize', refreshHeroBounds);
      motion.removeEventListener('change', updateVisibility);
      heroObserver?.disconnect();
    };
  }, []);

  return (
    <div id="lightvela-home-pointer-mascot" ref={mascotRef} aria-hidden="true">
      <img className="home-pointer-mascot__open" src={`${ASSET_ROOT}/hermes-pointer-lilac-open.webp`} alt="" draggable={false} loading="lazy" />
      <img className="home-pointer-mascot__wink" src={`${ASSET_ROOT}/hermes-pointer-lilac-wink.webp`} alt="" draggable={false} loading="lazy" />
    </div>
  );
}
