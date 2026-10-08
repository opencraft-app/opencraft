import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { mountInternationalHomeMotion } from '../international-home-motion';
import { HERO_ARTWORK_TRIGGER_ID } from '../home-hero-artwork';

let root: HTMLElement;
let dispose: (() => void) | undefined;
let reduce = false;
let mobile = false;
const queries = new Map<string, MediaQueryList>();
let notifyVisibility: IntersectionObserverCallback;
let disconnectVisibility: ReturnType<typeof vi.fn>;
const rect = (top: number) => ({ x: 0, y: top, top, left: 0, right: 300, bottom: top + 250, width: 300, height: 250, toJSON() {} });

beforeEach(() => {
  reduce = false;
  mobile = false;
  queries.clear();
  disconnectVisibility = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { notifyVisibility = callback; }
    observe() {}
    unobserve() {}
    disconnect = disconnectVisibility;
  });
  vi.stubGlobal('matchMedia', (query: string) => {
    if (!queries.has(query)) {
      const target = new EventTarget();
      const match = Object.assign(target, {
        media: query,
        onchange: null,
        addListener: (listener: EventListener) => target.addEventListener('change', listener),
        removeListener: (listener: EventListener) => target.removeEventListener('change', listener),
      });
      Object.defineProperty(match, 'matches', { get: () => {
        if (query.includes('prefers-reduced-motion')) return reduce;
        if (query.includes('min-width: 900px')) return !mobile;
        if (query.includes('max-width: 899px')) return mobile;
        if (query.includes('hover: hover')) return !mobile;
        return false;
      } });
      queries.set(query, match as MediaQueryList);
    }
    return queries.get(query)!;
  });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect(1800));
  document.body.innerHTML = `<main id="lightvela-intl-home">
    <section class="hero"><span class="home-cover-mascot"><img style="transform: translateY(-67%)"></span><div class="hero__cta"><a href="/subscribe">Try</a></div></section>
    <section class="about is-motion"><div class="about__cards"><article class="wcard"><div class="wcard__inner"><div class="feature-motion-page"><div class="feature-motion-channel">WhatsApp</div><div class="feature-motion-channel">Telegram</div><div class="feature-motion-channel">Discord</div></div></div></article><article class="wcard"><div class="wcard__inner"><span class="feature-skill">Skill 1</span><span class="feature-skill">Skill 2</span></div></article></div></section>
    <section class="scenes"><header class="scenes__head"><span class="scenes__mascot"><img></span></header><input type="radio" id="sc-1" name="scene" checked><input type="radio" id="sc-2" name="scene"><div id="scene-1"><div class="scene__split">First</div></div><div id="scene-2"><div class="scene__split">Second</div></div></section>
    <section class="deploy"><span class="home-step-mascot" style="--step-left: 300px; --step-top: 30px"><img width="676" height="591"></span></section>
    <div class="plays"><input type="radio" id="pl-2" name="play" checked><input type="radio" id="pl-3" name="play"><div id="play-2"><div class="play__text">One</div><div class="play__screen">Screen</div></div><div id="play-3"><div class="play__text">Two</div><div class="play__screen">Screen 2</div></div></div>
    <section class="cta"><span class="home-cta-mascot" style="transform: translateY(-100%)"><img></span><div class="cta__stage"><div class="cta__acts"><a href="/subscribe">Start</a></div></div></section>
    <footer><div class="home-footer-boundary"><svg viewBox="0 0 964 966"><image href="/hermes-door.webp"></image></svg></div></footer>
  </main>`;
  root = document.querySelector<HTMLElement>('#lightvela-intl-home')!;
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  ScrollTrigger.getAll().forEach((trigger) => trigger.kill());
  gsap.ticker.sleep();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// The hero friends' position observer is not an entrance; it stays under reduced motion.
const motionTriggers = () => ScrollTrigger.getAll().filter((trigger) => trigger.vars?.id !== HERO_ARTWORK_TRIGGER_ID);

function switchPanel(id: string) {
  const input = root.querySelector<HTMLInputElement>(`#${id}`)!;
  const panel = root.querySelector<HTMLElement>(`#${id.replace('pl-', 'play-').replace('sc-', 'scene-')}`)!;
  vi.spyOn(panel, 'getBoundingClientRect').mockImplementation(() => rect(100));
  input.checked = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return panel;
}

describe('international homepage motion', () => {
  it('replays the hero and later stage entrances on return while keeping content visible', () => {
    dispose = mountInternationalHomeMotion(root);
    expect(root.dataset.homeMotionReady).toBe('active');
    const triggers = motionTriggers();
    expect(triggers.length).toBeGreaterThanOrEqual(5);
    expect(triggers.every((trigger) => !trigger.vars.pin && !trigger.vars.snap)).toBe(true);
    expect(triggers.filter((trigger) => trigger.vars.scrub).length).toBeGreaterThan(0);
    expect(triggers.filter((trigger) => !trigger.vars.scrub).every((trigger) =>
      trigger.vars.toggleActions === 'restart none restart none',
    )).toBe(true);
    expect(root.querySelector<HTMLElement>('.wcard')!.style.opacity).not.toBe('0');
    expect(root.querySelector('.pin-spacer')).toBeNull();
    const cardEntrance = triggers.find((trigger) => trigger.trigger?.matches('.wcard'))!.animation as gsap.core.Timeline;
    const tween = cardEntrance.getChildren()[0];
    expect(tween.vars.startAt.rotationX).toBeUndefined();
    expect(tween.vars.startAt.y).toBe(32);
    expect(tween.duration()).toBeLessThanOrEqual(0.7);
  });

  it('keeps the original mascot positioning and dimensions after cleanup', () => {
    const hero = root.querySelector<HTMLElement>('.home-cover-mascot img')!;
    const step = root.querySelector<HTMLElement>('.home-step-mascot')!;
    const cta = root.querySelector<HTMLElement>('.home-cta-mascot')!;
    const previous = [hero, step, cta].map((element) => element.getAttribute('style'));
    dispose = mountInternationalHomeMotion(root);
    ScrollTrigger.getAll().forEach((trigger) => trigger.animation?.progress(0.5));
    dispose();
    expect([hero, step, cta].map((element) => element.getAttribute('style'))).toEqual(previous);
    expect(root.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 964 966');
    expect(root.querySelector('.home-step-mascot img')?.getAttribute('width')).toBe('676');
    expect(root.hasAttribute('data-home-motion-ready')).toBe(false);
    expect(ScrollTrigger.getAll()).toHaveLength(0);
  });

  it('keeps the mascot in the hero without mounting a page-following character', () => {
    const image = root.querySelector<HTMLImageElement>('.home-cover-mascot img')!;
    image.src = '/lightvela-intl-home/assets/lv-cover-lavender.webp';
    dispose = mountInternationalHomeMotion(root);
    expect(root.querySelector('.hero .home-cover-mascot img')).toBe(image);
    expect(gsap.getTweensOf(root.querySelector('.home-cover-mascot'))).toHaveLength(0);
    ScrollTrigger.getAll().forEach((trigger) => trigger.animation?.progress(1));
    expect(image.style.visibility).not.toBe('hidden');
  });

  it('does not multiply triggers on repeated initialization or a dispose event', () => {
    const first = mountInternationalHomeMotion(root);
    const count = ScrollTrigger.getAll().length;
    dispose = mountInternationalHomeMotion(root);
    expect(ScrollTrigger.getAll()).toHaveLength(count);
    first();
    expect(ScrollTrigger.getAll()).toHaveLength(count);
    document.dispatchEvent(new Event('lightvela-home-dispose'));
    expect(ScrollTrigger.getAll()).toHaveLength(0);
    expect(root.hasAttribute('data-home-motion-ready')).toBe(false);
  });

  it('respects reduced motion initially and when the preference changes', async () => {
    reduce = true;
    dispose = mountInternationalHomeMotion(root);
    expect(root.dataset.homeMotionReady).toBe('reduced');
    expect(motionTriggers()).toHaveLength(0);
    expect(ScrollTrigger.getById(HERO_ARTWORK_TRIGGER_ID)).toBeTruthy();
    const panel = switchPanel('pl-3');
    expect(gsap.getTweensOf(panel.querySelector('.play__screen'))).toHaveLength(0);
    reduce = false;
    await new Promise((resolve) => setTimeout(resolve, 10));
    queries.get('(prefers-reduced-motion: reduce)')!.dispatchEvent(new Event('change'));
    expect(root.dataset.homeMotionReady).toBe('active');
    expect(ScrollTrigger.getAll().length).toBeGreaterThan(0);
    reduce = true;
    await new Promise((resolve) => setTimeout(resolve, 10));
    queries.get('(prefers-reduced-motion: reduce)')!.dispatchEvent(new Event('change'));
    expect(root.dataset.homeMotionReady).toBe('reduced');
    expect(motionTriggers()).toHaveLength(0);
  });

  it('uses one gentle mobile card-strip entrance rather than rotating hidden horizontal cards', () => {
    mobile = true;
    dispose = mountInternationalHomeMotion(root);
    const triggers = ScrollTrigger.getAll();
    expect(triggers.some((trigger) => trigger.trigger?.matches('.about__cards'))).toBe(true);
    expect(triggers.some((trigger) => trigger.trigger?.matches('.wcard'))).toBe(false);
    const introTweens = gsap.getTweensOf(root.querySelector('.home-cover-mascot'));
    root.querySelector('.hero__cta')!.dispatchEvent(new Event('pointerenter'));
    expect(gsap.getTweensOf(root.querySelector('.home-cover-mascot'))).toEqual(introTweens);
    expect(triggers.every((trigger) => !trigger.vars.scrub)).toBe(true);
    expect(root.querySelector('.home-card-sheen')).toBeNull();
  });

  it('transitions selected panels and completes interrupted animations without hiding content', () => {
    dispose = mountInternationalHomeMotion(root);
    const firstPanel = switchPanel('pl-3');
    const firstScreen = firstPanel.querySelector<HTMLElement>('.play__screen')!;
    const tween = gsap.getTweensOf(firstScreen)[0];
    expect(tween).toBeDefined();
    expect(tween.duration()).toBeLessThan(0.3);
    tween.progress(0.4);
    switchPanel('pl-2');
    expect(gsap.getTweensOf(firstScreen)).toHaveLength(0);
    expect(firstScreen.style.opacity).toBe('');
    expect(firstScreen.style.transform).toBe('');
    dispose();
    const nextPanel = switchPanel('pl-3');
    expect(gsap.getTweensOf(nextPanel.querySelector('.play__screen'))).toHaveLength(0);
  });

  it('keeps keyboard panel switching immediate', () => {
    dispose = mountInternationalHomeMotion(root);
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const panel = switchPanel('sc-2');
    expect(gsap.getTweensOf(panel.querySelector('.scene__split'))).toHaveLength(0);
    root.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    const nextPanel = switchPanel('sc-1');
    expect(gsap.getTweensOf(nextPanel.querySelector('.scene__split')).length).toBeGreaterThan(0);
  });

  it('leaves scrolling messages and scheduled task loops under the existing CSS playback controller', async () => {
    const cards = root.querySelector('.about__cards')!;
    cards.insertAdjacentHTML('beforeend', '<article class="wcard" id="scrolling-channels"><div class="feature-motion-pages"><div class="feature-motion-page"><div class="feature-motion-channel">WhatsApp</div></div></div></article><article class="wcard" id="looping-tasks"><div class="feature-motion-tasks"><div class="feature-task__case"><span>First task</span></div><div class="feature-task__case"><span>Next task</span></div></div></article>');
    dispose = mountInternationalHomeMotion(root);
    const targets = root.querySelectorAll('#scrolling-channels .feature-motion-channel, #looping-tasks .feature-task__case > *');
    for (const card of root.querySelectorAll('#scrolling-channels, #looping-tasks')) {
      card.dispatchEvent(new Event('pointerenter'));
      card.dispatchEvent(new Event('pointerleave'));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    targets.forEach((target) => expect(gsap.getTweensOf(target)).toHaveLength(0));
    expect(root.querySelectorAll('#looping-tasks .feature-task__case')).toHaveLength(2);
  });

  function prepareLoops() {
    root.querySelector('.about__cards')!.insertAdjacentHTML('beforeend', '<article class="wcard"><div class="wcard__demo--cloud"></div></article><article class="wcard"><div class="feature-copy-preview"><span>Send?</span><span>Confirmed.</span></div></article><article class="wcard"><div class="feature-workspace-arrow"></div></article><article class="wcard"><div class="feature-motion-wave"><img></div></article>');
    dispose = mountInternationalHomeMotion(root);
    const targets = Array.from(root.querySelectorAll<HTMLElement>('.wcard__demo--cloud, .feature-copy-preview span:first-child'));
    const timelines = targets.map((target) => gsap.getTweensOf(target)[0].parent as gsap.core.Timeline);
    const emit = (isIntersecting: boolean) => notifyVisibility(targets.map((target) => ({
      target: target.closest('.wcard'), isIntersecting, intersectionRatio: isIntersecting ? 0.8 : 0,
    })) as IntersectionObserverEntry[], {} as IntersectionObserver);
    return { targets, timelines, emit };
  }

  it('keeps all visible previews looping independently without hover or one-shot limits', () => {
    const { timelines, emit } = prepareLoops();
    expect(timelines.every((timeline) => timeline.paused())).toBe(true);
    emit(true);
    for (const timeline of timelines) {
      expect(timeline.paused()).toBe(false);
      expect(timeline.repeat()).toBe(-1);
      timeline.totalTime((timeline.duration() + timeline.repeatDelay()) * 3 + 0.3);
      expect(timeline.iteration()).toBeGreaterThanOrEqual(4);
      expect(timeline.paused()).toBe(false);
    }
  });

  it('does not stop, rewind or serialize visible loops after pointer or keyboard input', () => {
    const { targets, timelines, emit } = prepareLoops();
    emit(true);
    timelines.forEach((timeline) => timeline.totalTime(1.2));
    targets.forEach((target) => {
      target.closest('.wcard')!.dispatchEvent(new Event('pointerenter'));
      target.closest('.wcard')!.dispatchEvent(new Event('pointerleave'));
    });
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    timelines.forEach((timeline) => {
      expect(timeline.paused()).toBe(false);
      expect(timeline.totalTime()).toBeCloseTo(1.2);
    });
  });

  it('plays visible loops on touch and removes them when reduced motion is enabled', async () => {
    mobile = true;
    const { targets, timelines, emit } = prepareLoops();
    emit(true);
    expect(timelines.every((timeline) => !timeline.paused())).toBe(true);
    expect(root.querySelector('.home-card-sheen')).toBeNull();
    reduce = true;
    await new Promise((resolve) => setTimeout(resolve, 10));
    queries.get('(prefers-reduced-motion: reduce)')!.dispatchEvent(new Event('change'));
    targets.forEach((target) => {
      expect(gsap.getTweensOf(target)).toHaveLength(0);
      expect(target.style.opacity).toBe('');
      expect(target.style.transform).toBe('');
    });
  });

  it('pauses in the background without jumping to the end, then resumes visible previews', () => {
    const { timelines, emit } = prepareLoops();
    emit(true);
    timelines.forEach((timeline) => timeline.totalTime(1.5));
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    timelines.forEach((timeline) => {
      expect(timeline.paused()).toBe(true);
      expect(timeline.totalTime()).toBeCloseTo(1.5);
    });
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(timelines.every((timeline) => !timeline.paused())).toBe(true);
  });

  it('resumes offscreen previews at the same phase and cancels observers on cleanup', () => {
    const { targets, timelines, emit } = prepareLoops();
    emit(true);
    timelines.forEach((timeline) => timeline.totalTime(2));
    emit(false);
    expect(timelines.every((timeline) => timeline.paused())).toBe(true);
    emit(true);
    timelines.forEach((timeline) => {
      expect(timeline.paused()).toBe(false);
      expect(timeline.totalTime()).toBeCloseTo(2);
    });
    dispose!();
    expect(disconnectVisibility).toHaveBeenCalled();
    emit(true);
    targets.forEach((target) => {
      expect(gsap.getTweensOf(target)).toHaveLength(0);
      expect(target.style.transform).toBe('');
      expect(target.style.opacity).toBe('');
    });
  });

  it('leaves skills, the workspace arrow and memory waves under CSS control', () => {
    const { emit } = prepareLoops();
    emit(true);
    root.querySelectorAll('.feature-skill, .feature-workspace-arrow, .feature-motion-wave img').forEach((target) => {
      expect(gsap.getTweensOf(target)).toHaveLength(0);
    });
    const css = readFileSync('public/lightvela-intl-home/assets/hermes-home.css', 'utf8');
    for (const [selector, animation] of [
      ['.feature-motion-pages', 'feature-chat-pages'],
      ['.feature-task__case', 'feature-task-case'],
      ['.feature-skill', 'feature-skill-inward'],
      ['.feature-workspace-arrow', 'feature-arrow-travel'],
      ['.feature-motion-wave img', 'feature-wave-flow'],
    ]) {
      const rules = Array.from(css.matchAll(/([^{}]+)\{([^{}]+)\}/g));
      const rule = rules.find((match) => match[1].includes(`[data-feature-motion-ready] ${selector}`) && match[2].includes(`animation: ${animation}`));
      expect(rule?.[2]).toContain('infinite');
      const disabled = rules.filter((match) => match[1].includes('[data-home-motion-ready') && match[1].includes(selector) && /animation:\s*none/.test(match[2]));
      expect(disabled.every((match) => match[1].includes("[data-home-motion-ready='reduced']"))).toBe(true);
    }
  });

  it('falls back to visibility measurement without IntersectionObserver', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect(100));
    const { targets, timelines } = prepareLoops();
    expect(timelines.every((timeline) => !timeline.paused())).toBe(true);
    targets.forEach((target) => vi.spyOn(target.closest<HTMLElement>('.wcard')!, 'getBoundingClientRect').mockImplementation(() => rect(4000)));
    document.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(timelines.every((timeline) => timeline.paused())).toBe(true);
  });

  it('removes all stage decorations and restores card transforms on media cleanup', async () => {
    const card = root.querySelector<HTMLElement>('.wcard')!;
    const inner = card.querySelector<HTMLElement>('.wcard__inner')!;
    const before = inner.getAttribute('style');
    dispose = mountInternationalHomeMotion(root);
    expect(root.querySelectorAll('.home-stage-light,.home-stage-orbit')).toHaveLength(0);
    expect(gsap.getTweensOf(root.querySelector('.home-cover-mascot'))).toHaveLength(0);
    expect(root.querySelectorAll('.home-portal-shutter,.home-portal-halo')).toHaveLength(0);
    expect(root.querySelectorAll('.home-card-sheen')).toHaveLength(2);
    card.dispatchEvent(new MouseEvent('pointermove', { clientX: 250, clientY: 1850 }));
    gsap.getTweensOf(inner).forEach((tween) => tween.progress(1));
    expect(inner.style.transform).toContain('rotate');
    reduce = true;
    await new Promise((resolve) => setTimeout(resolve, 10));
    queries.get('(prefers-reduced-motion: reduce)')!.dispatchEvent(new Event('change'));
    expect(root.querySelectorAll('.home-stage-light,.home-stage-orbit,.home-portal-shutter,.home-portal-halo,.home-cta-light,.home-card-sheen')).toHaveLength(0);
    expect(inner.getAttribute('style') || null).toBe(before);
    expect(motionTriggers()).toHaveLength(0);
  });

  it('keeps the original portal artwork visible while character layers are loading', () => {
    dispose = mountInternationalHomeMotion(root);
    expect(root.querySelectorAll('.home-portal-shutter,.home-portal-halo,.home-door-peek-layers')).toHaveLength(0);
    expect(root.querySelector('.home-footer-boundary svg')?.getAttribute('viewBox')).toBe('0 0 964 966');
    expect(root.querySelector('.home-footer-boundary image')?.getAttribute('href')).toBe('/hermes-door.webp');
    expect(root.querySelector<SVGElement>('.home-footer-boundary svg')?.style.transform).toBe('');
  });

  it('can refresh and rebuild at the bottom of the page without deleting triggers mid-refresh', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect(-1200));
    dispose = mountInternationalHomeMotion(root);
    const count = ScrollTrigger.getAll().length;
    expect(() => ScrollTrigger.refresh()).not.toThrow();
    ScrollTrigger.getAll().forEach((trigger) => trigger.animation?.progress(1));
    expect(ScrollTrigger.getAll()).toHaveLength(count);
    reduce = true;
    await new Promise((resolve) => setTimeout(resolve, 10));
    queries.get('(prefers-reduced-motion: reduce)')!.dispatchEvent(new Event('change'));
    expect(motionTriggers()).toHaveLength(0);
    reduce = false;
    await new Promise((resolve) => setTimeout(resolve, 10));
    queries.get('(prefers-reduced-motion: reduce)')!.dispatchEvent(new Event('change'));
    expect(() => ScrollTrigger.refresh()).not.toThrow();
    expect(ScrollTrigger.getAll()).toHaveLength(count);
    expect(root.querySelectorAll('.home-stage-orbit,.home-stage-light')).toHaveLength(0);
  });

  it('settles panel transitions while the document is hidden', () => {
    dispose = mountInternationalHomeMotion(root);
    const panel = switchPanel('pl-3');
    const target = panel.querySelector<HTMLElement>('.play__text')!;
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(gsap.getTweensOf(target)).toHaveLength(0);
    expect(target.style.opacity).toBe('');
    expect(target.style.transform).toBe('');
  });
});
