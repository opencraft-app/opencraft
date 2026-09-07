import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = readFileSync(path.resolve('public/lightvela-intl-home/runtime.js'), 'utf8');
const playsRuntime = runtime.slice(runtime.indexOf("(function () {\n  var labels = Array.prototype.slice.call(document.querySelectorAll('.plays__tabs"));
let observe: (entries: { isIntersecting: boolean; intersectionRatio: number }[]) => void;
let phone = false;

beforeEach(() => {
  vi.useFakeTimers();
  phone = false;
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query.includes('640px') && phone; },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof observe) { observe = callback; }
    observe() {}
    disconnect() {}
  });
  document.body.innerHTML = `<section class="plays">
    <input type="radio" name="play" id="pl-2" checked><input type="radio" name="play" id="pl-3"><input type="radio" name="play" id="pl-4">
    <div class="plays__tabs"><label for="pl-2">Auto</label><label for="pl-3">Work</label><label for="pl-4">Harness</label></div>
    <div class="plays__stage"><div class="play">Content</div></div>
  </section>`;
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });
const selected = () => document.querySelector<HTMLInputElement>('.plays input:checked')?.id;
const start = () => new Function(playsRuntime)();

describe('homepage play reading time', () => {
  it('waits eight seconds with the panel visible before advancing', () => {
    start();
    expect(observe).toBeTypeOf('function');
    observe([{ isIntersecting: true, intersectionRatio: 0.8 }]);
    vi.advanceTimersByTime(7999);
    expect(selected()).toBe('pl-2');
    vi.advanceTimersByTime(1);
    expect(selected()).toBe('pl-3');
    vi.advanceTimersByTime(8000);
    expect(selected()).toBe('pl-4');
  });
  it('does not rotate while offscreen or after a manual selection', () => {
    start();
    observe([{ isIntersecting: true, intersectionRatio: 0.8 }]);
    vi.advanceTimersByTime(4000);
    observe([{ isIntersecting: false, intersectionRatio: 0 }]);
    vi.advanceTimersByTime(12000);
    expect(selected()).toBe('pl-2');
    observe([{ isIntersecting: true, intersectionRatio: 0.8 }]);
    document.querySelector<HTMLLabelElement>('label[for="pl-4"]')!.click();
    vi.advanceTimersByTime(16000);
    expect(selected()).toBe('pl-4');
  });
  it('never changes content or scrolls the page during phone vertical scrolling', () => {
    phone = true;
    start();
    observe([{ isIntersecting: true, intersectionRatio: 1 }]);
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(24000);
    expect(selected()).toBe('pl-2');
    expect(playsRuntime).not.toContain('scrollIntoView');
  });
  it('restores desktop hover activation for every play tab', () => {
    start();
    for (const id of ['pl-3', 'pl-4', 'pl-2']) {
      document.querySelector(`label[for="${id}"]`)!.dispatchEvent(new MouseEvent('mouseenter'));
      expect(selected()).toBe(id);
    }
  });
  it('ignores synthetic hover on phones', () => {
    phone = true;
    start();
    document.querySelector('label[for="pl-3"]')!.dispatchEvent(new MouseEvent('mouseenter'));
    expect(selected()).toBe('pl-2');
  });
  it('keeps vertical touch gestures native and handles horizontal swipes only in the tab strip', () => {
    phone = true;
    const tabs = document.querySelector<HTMLElement>('.plays__tabs')!;
    const scrollTabs = vi.fn();
    tabs.scrollTo = scrollTabs;
    const stage = document.querySelector('.plays__stage')!;
    const touch = (type: string, x: number, y: number) => {
      const event = new Event(type, { cancelable: true });
      Object.defineProperty(event, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
      stage.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    };
    start();
    touch('touchstart', 200, 600);
    touch('touchend', 190, 250);
    expect(selected()).toBe('pl-2');
    expect(scrollTabs).not.toHaveBeenCalled();
    touch('touchstart', 280, 300);
    touch('touchend', 80, 310);
    expect(selected()).toBe('pl-3');
    expect(scrollTabs).toHaveBeenCalledOnce();
  });
  it('stops pending playback when the homepage unmounts', () => {
    start();
    observe([{ isIntersecting: true, intersectionRatio: 1 }]);
    document.dispatchEvent(new Event('lightvela-home-dispose'));
    vi.advanceTimersByTime(24000);
    expect(selected()).toBe('pl-2');
  });
});
