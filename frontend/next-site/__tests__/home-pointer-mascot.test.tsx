import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HomePointerMascot } from '@next-site/home-pointer-mascot';

function movePointer(x: number, y: number) {
  const event = new Event('pointermove');
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
    pointerType: { value: 'mouse' },
  });
  act(() => document.dispatchEvent(event));
}

describe('home pointer mascot', () => {
  let frameCallback: FrameRequestCallback | undefined;
  let motionMatches = true;

  beforeEach(() => {
    vi.stubGlobal('React', React);
    motionMatches = true;
    vi.stubGlobal('matchMedia', () => ({
      get matches() { return motionMatches; },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const hero = document.createElement('section');
    hero.className = 'hero';
    const home = document.createElement('div');
    home.id = 'lightvela-intl-home';
    home.appendChild(hero);
    document.body.appendChild(home);
    vi.spyOn(hero, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 1000, top: 0, bottom: 300,
    } as DOMRect);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.getElementById('lightvela-intl-home')?.remove();
    frameCallback = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('hides over Hero and eases toward the pointer elsewhere', () => {
    const { container } = render(<HomePointerMascot />);
    const mascot = container.querySelector<HTMLElement>('#lightvela-home-pointer-mascot')!;

    movePointer(100, 100);
    expect(mascot.classList.contains('is-visible')).toBe(false);

    movePointer(100, 400);
    expect(mascot.classList.contains('is-visible')).toBe(true);
    expect(mascot.style.transform).toContain('118px, 418px');

    movePointer(300, 400);
    act(() => frameCallback?.(16));
    const movedX = Number(mascot.style.transform.match(/translate3d\(([^p]+)px/)?.[1]);
    expect(movedX).toBeGreaterThan(118);
    expect(movedX).toBeLessThan(318);

    movePointer(100, 100);
    expect(mascot.classList.contains('is-visible')).toBe(false);
  });

  it('hides the follower in the footer and restores it outside the footer', () => {
    const footer = document.createElement('footer'); footer.className = 'foot';
    document.getElementById('lightvela-intl-home')!.append(footer);
    vi.spyOn(footer, 'getBoundingClientRect').mockReturnValue({left:0,right:1000,top:600,bottom:1000} as DOMRect);
    const {container} = render(<HomePointerMascot />);
    const mascot = container.querySelector('#lightvela-home-pointer-mascot')!;
    movePointer(100,400); expect(mascot.classList.contains('is-visible')).toBe(true);
    movePointer(100,700); expect(mascot.classList.contains('is-visible')).toBe(false);
    movePointer(100,400); expect(mascot.classList.contains('is-visible')).toBe(true);
  });

  it('does not show when reduced motion is requested', () => {
    motionMatches = false;
    const { container } = render(<HomePointerMascot />);
    movePointer(100, 400);
    expect(container.querySelector('#lightvela-home-pointer-mascot')?.classList.contains('is-visible')).toBe(false);
  });

  it('fades after pointer inactivity and returns on movement', () => {
    vi.useFakeTimers();
    const { container } = render(<HomePointerMascot />);
    const mascot = container.querySelector<HTMLElement>('#lightvela-home-pointer-mascot')!;

    movePointer(100, 400);
    act(() => vi.advanceTimersByTime(1199));
    expect(mascot.classList.contains('is-idle')).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(mascot.classList.contains('is-idle')).toBe(true);

    movePointer(200, 400);
    expect(mascot.classList.contains('is-idle')).toBe(false);
    act(() => vi.advanceTimersByTime(1200));
    expect(mascot.classList.contains('is-idle')).toBe(true);
  });

  it('briefly winks while visible', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { container } = render(<HomePointerMascot />);
    const mascot = container.querySelector<HTMLElement>('#lightvela-home-pointer-mascot')!;
    movePointer(100, 400);

    for (let step = 1; step <= 3; step += 1) {
      act(() => vi.advanceTimersByTime(1000));
      movePointer(100 + step, 400);
    }
    act(() => vi.advanceTimersByTime(200));
    expect(mascot.classList.contains('is-winking')).toBe(true);
    act(() => vi.advanceTimersByTime(240));
    expect(mascot.classList.contains('is-winking')).toBe(false);
  });
});
