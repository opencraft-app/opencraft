import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gsap } from 'gsap';
import { mountMascotLife } from '../international-home-mascot-life';
import { mountTestimonialFriends } from '../international-home-testimonial-friends';

let root: HTMLElement;
let dispose: (() => void) | undefined;
let notify: IntersectionObserverCallback;
let reduced = false;
const disconnect = vi.fn();

beforeEach(() => {
  reduced = false;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { notify = callback; }
    observe() {}
    disconnect = disconnect;
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('no-preference') ? !reduced : true,
    media: query, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
  }));
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  document.body.innerHTML = '<main><span class="home-cover-mascot"><img style="transform:translateY(-67%)"></span><span class="scenes__mascot"><img></span><section class="voice"><div class="marquee__rows">Unchanged reviews</div></section></main>';
  root = document.querySelector('main')!;
});

afterEach(() => {
  dispose?.(); dispose = undefined;
  gsap.ticker.sleep();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  delete (document as { hidden?: boolean }).hidden;
  document.body.innerHTML = '';
});

function intersect(target: Element, isIntersecting: boolean) {
  notify([{ target, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
}

describe('homepage mascot life', () => {
  it('plays in view, pauses while hidden, rewinds outside and replays on return', () => {
    dispose = mountMascotLife(root, { desktop: true, hover: true });
    const image = root.querySelector<HTMLElement>('.scenes__mascot img')!;
    const surface = image.parentElement!;
    const tween = gsap.getTweensOf(surface)[0];
    const timeline = tween.parent as gsap.core.Timeline;
    expect(timeline.paused()).toBe(true);
    intersect(image, true);
    expect(timeline.paused()).toBe(false);
    timeline.time(0.75);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(timeline.paused()).toBe(true);
    expect(surface.style.willChange).toBe('');
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(timeline.paused()).toBe(false);
    intersect(image, false);
    expect(timeline.time()).toBe(0);
    expect(timeline.paused()).toBe(true);
    intersect(image, true);
    expect(surface.dataset.mascotPlaying).toBe('true');
    expect(timeline.paused()).toBe(false);
  });

  it('preserves positioning and removes wrappers/listeners on cleanup', () => {
    const image = root.querySelector<HTMLElement>('.scenes__mascot img')!;
    const before = image.getAttribute('style');
    dispose = mountMascotLife(root, { desktop: true, hover: true });
    intersect(image, true);
    expect(root.querySelector('.home-cover-mascot .home-mascot-life')).toBeNull();
    expect(gsap.getTweensOf(root.querySelector('.home-cover-mascot img'))).toHaveLength(0);
    dispose();
    expect(root.querySelector('.home-mascot-life')).toBeNull();
    expect(image.getAttribute('style')).toBe(before);
    expect(disconnect).toHaveBeenCalled();
  });

  it('keeps seven side friends static with reduced motion and leaves reviews intact', () => {
    reduced = true;
    dispose = mountTestimonialFriends(root);
    expect(root.querySelectorAll('.home-testimonial-friend--left')).toHaveLength(4);
    expect(root.querySelectorAll('.home-testimonial-friend--right')).toHaveLength(3);
    const images = root.querySelectorAll<HTMLImageElement>('.home-testimonial-friend img');
    expect([...images].every((image) => gsap.getTweensOf(image).length === 0)).toBe(true);
    expect(root.querySelector('.marquee__rows')?.textContent).toBe('Unchanged reviews');
    dispose();
    expect(root.querySelector('.home-testimonial-friends')).toBeNull();
    expect(root.querySelector('.voice')?.classList.contains('has-peek-friends')).toBe(false);
  });

  it('keeps the leaning outer poses while inner peeks replay and leaves marquee layout untouched', () => {
    const reviews = root.querySelector<HTMLElement>('.marquee__rows')!;
    const originalReviewStyle = reviews.getAttribute('style');
    dispose = mountTestimonialFriends(root);
    const slot = root.querySelector<HTMLElement>('.home-testimonial-friend--left')!;
    const image = slot.querySelector('img')!;
    const basePose = slot.getAttribute('style');
    expect(Number.parseFloat(slot.style.getPropertyValue('--peek-angle'))).toBeGreaterThanOrEqual(25);
    expect(gsap.getTweensOf(slot)).toHaveLength(0);
    intersect(slot, true);
    const timeline = gsap.getTweensOf(image)[0].parent as gsap.core.Timeline;
    timeline.time(1.1);
    expect(slot.getAttribute('style')).toBe(basePose);
    timeline.time(timeline.duration());
    expect(slot.getAttribute('style')).toBe(basePose);
    intersect(slot, false);
    expect(timeline.time()).toBe(0);
    intersect(slot, true);
    expect(slot.getAttribute('style')).toBe(basePose);
    expect(reviews.getAttribute('style')).toBe(originalReviewStyle);
    expect(reviews.textContent).toBe('Unchanged reviews');
  });

  it('has no timer or animation fallback when visibility observation is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    dispose = mountMascotLife(root, { desktop: false, hover: false });
    root.querySelectorAll<HTMLElement>('.home-mascot-life').forEach((surface) => {
      expect(surface.dataset.mascotPlaying).toBe('false');
      expect((gsap.getTweensOf(surface)[0].parent as gsap.core.Timeline).paused()).toBe(true);
    });
  });
});
