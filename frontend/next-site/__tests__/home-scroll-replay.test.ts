import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
const source = readFileSync('public/lightvela-intl-home/runtime.js', 'utf8');
const start = source.indexOf("  (function () {\n    var els = document.querySelectorAll('.sr');");
const end = source.indexOf("  (function () {", start + 5);
afterEach(() => { document.dispatchEvent(new Event('lightvela-home-dispose')); vi.unstubAllGlobals(); document.body.innerHTML = ''; });
it('replays reveals after leaving either viewport edge and cleans up its observer', () => {
  let notify: (entries: object[]) => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof notify) { notify = callback; }
    observe() {} disconnect = disconnect;
  });
  document.body.innerHTML = '<div class="sr"></div>';
  window.eval(source.slice(start, end));
  const target = document.querySelector('.sr')!;
  for (let pass = 0; pass < 3; pass++) {
    notify([{ target, isIntersecting: true, intersectionRatio: .5 }]);
    expect(target.classList.contains('is-in')).toBe(true);
    notify([{ target, isIntersecting: false, intersectionRatio: 0 }]);
    expect(target.classList.contains('is-in')).toBe(false);
  }
  document.dispatchEvent(new Event('lightvela-home-dispose'));
  expect(disconnect).toHaveBeenCalledOnce();
});
