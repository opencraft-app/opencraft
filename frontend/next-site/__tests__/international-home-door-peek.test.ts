import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { mountDoorPeek } from '../international-home-door-peek';

class TestImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() { images.push(this); }
}
let images: TestImage[] = [];
let portal: HTMLElement;
let dispose: () => void;
const loaded = async () => {
  images.forEach((image) => image.onload?.());
  await Promise.resolve();
};

beforeEach(() => {
  images = [];
  vi.stubGlobal('Image', TestImage);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    x: 0, y: 1800, top: 1800, bottom: 2240, left: 0, right: 500, width: 500, height: 440, toJSON() {},
  }));
  gsap.registerPlugin(ScrollTrigger);
  document.body.innerHTML = '<div class="home-footer-boundary"><svg viewBox="0 0 964 966" preserveAspectRatio="xMidYMid meet"><image href="/lightvela-intl-home/assets/hermes-door.webp" width="964" height="966" /></svg></div>';
  portal = document.querySelector('.home-footer-boundary')!;
  dispose = mountDoorPeek(portal);
});

afterEach(() => {
  dispose();
  ScrollTrigger.getAll().forEach((trigger) => trigger.kill());
  gsap.ticker.sleep();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('door character peek', () => {
  it('preloads both layers without replacing or hiding the original artwork', async () => {
    expect(images.map((image) => image.src)).toEqual([
      '/lightvela-intl-home/assets/hermes-door-white.webp?v=20260930-home-visual-v1',
      '/lightvela-intl-home/assets/hermes-door-character.webp?v=20260930-home-visual-v1',
    ]);
    expect(portal.querySelector('.home-door-peek-layers')).toBeNull();
    expect(portal.querySelector('image')?.getAttribute('href')).toContain('hermes-door.webp');
    await loaded();
    expect(portal.dataset.doorPeek).toBe('ready');
    expect(portal.querySelectorAll('.home-door-peek-character')).toHaveLength(1);
  });

  it('moves only the character behind a stationary door-frame clip', async () => {
    await loaded();
    const artwork = portal.querySelector('svg')!;
    const character = portal.querySelector<SVGGElement>('.home-door-peek-character')!;
    const background = portal.querySelector<SVGImageElement>('.home-door-peek-background')!;
    const timeline = ScrollTrigger.getAll().find((trigger) => trigger.trigger === portal)!.animation!;
    expect(Number(gsap.getProperty(character, 'x'))).toBe(-136);
    const clip = character.parentElement!;
    expect(clip.getAttribute('clip-path')).toMatch(/^url\(#home-door-peek-/);
    expect(portal.querySelector('polygon')?.getAttribute('points')).toBe('374,151 529,44 529,774 374,760');
    timeline.time(0.88);
    expect(Number(gsap.getProperty(character, 'x'))).toBeCloseTo(-40);
    timeline.time(1.66);
    expect(Number(gsap.getProperty(character, 'x'))).toBeCloseTo(0);
    expect(gsap.getTweensOf(background)).toHaveLength(0);
    expect(gsap.getTweensOf(artwork)).toHaveLength(0);
    expect(background.getAttribute('transform')).toBeNull();
    expect(clip.getAttribute('transform')).toBeNull();
    expect(artwork.getAttribute('viewBox')).toBe('0 0 964 966');
    expect(portal.querySelectorAll('.home-portal-halo,.home-portal-shutter')).toHaveLength(0);
  });

  it('keeps the character visible against the white doorway at completion', async () => {
    await loaded();
    const timeline = ScrollTrigger.getAll().find((trigger) => trigger.trigger === portal)!.animation!;
    timeline.progress(1);
    expect(portal.dataset.doorPeek).toBe('complete');
    expect(portal.querySelector<SVGElement>('.home-door-peek-layers')!.style.display).not.toBe('none');
    expect(portal.querySelector('svg > image')?.getAttribute('href')).toBe('/lightvela-intl-home/assets/hermes-door.webp');
    expect(timeline.repeat()).toBe(0);
  });

  it('preserves the fallback if either layer fails to load', async () => {
    images[0].onload?.();
    images[1].onerror?.();
    await Promise.resolve();
    expect(portal.querySelectorAll('image')).toHaveLength(1);
    expect(portal.querySelector('defs')).toBeNull();
    expect(ScrollTrigger.getAll()).toHaveLength(0);
  });

  it('ignores delayed loads after unmount and cleans up animated layers', async () => {
    const callbacks = images.map((image) => image.onload!);
    dispose();
    callbacks.forEach((callback) => callback());
    await Promise.resolve();
    expect(portal.querySelector('.home-door-peek-layers')).toBeNull();
    images = [];
    dispose = mountDoorPeek(portal);
    await loaded();
    const timeline = ScrollTrigger.getAll().find((trigger) => trigger.trigger === portal)!.animation!;
    timeline.progress(0.5);
    dispose();
    expect(portal.querySelectorAll('image')).toHaveLength(1);
    expect(portal.querySelector('defs')).toBeNull();
    expect(portal.hasAttribute('data-door-peek')).toBe(false);
    expect(ScrollTrigger.getAll()).toHaveLength(0);
  });

  it('retains the layered assets in subsequent homepage imports', () => {
    const importer = readFileSync('scripts/import-international-homepage.mjs', 'utf8');
    for (const name of ['hermes-door-white.webp', 'hermes-door-character.webp']) {
      expect(importer).toContain(`"${name}"`);
      expect(readFileSync(`public/lightvela-intl-home/assets/${name}`).length).toBeGreaterThan(0);
    }
  });
});
