import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { normalizeHeroRuntime } from './international-home-feature-locales.mjs';

const importer = readFileSync(new URL('./import-international-homepage.mjs', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../public/lightvela-intl-home/runtime.js', import.meta.url), 'utf8');
const voiceStart = runtime.indexOf('(function () {\n  // Center-mode testimonial carousel.');
assert.ok(voiceStart > 0);
const base = runtime.slice(runtime.indexOf('\n') + 1, voiceStart).trimEnd();
// Run the importer's actual runtime assembly, without its destructive asset/HTML
// import. The retained base is the approved motion; appended widgets come only
// from the generator templates, so a legacy mrow template cannot pass parity.
const assembly = importer.slice(importer.indexOf('const runtimeSource = '), importer.indexOf('const heroChatCopies = '));
const generate = new Function('inlineScripts', 'normalizeHeroRuntime', `${assembly}\nreturn runtime;`);
const generated = generate([base], normalizeHeroRuntime);

test('regenerated runtime matches the checked-in motion and newest carousel byte for byte', () => {
  assert.equal(generated, runtime);
  assert.equal(generate([base], normalizeHeroRuntime), generated);
  assert.doesNotMatch(generated, /voice\.querySelectorAll\('\.mrow'\)/);
});

test('fresh generation of the approved character block includes restoration owned by its animation', () => {
  const legacyBase = base.replace(/  \(function \(\) \{\n    var INITIAL = 100;[\s\S]*?\n  \}\)\(\);/, `  (function () {\n    var INITIAL = 100;\n    var STEP = 30;\n    var shouldKeepNaturalText = false;\n  })();`);
  assert.notEqual(legacyBase, base);
  assert.equal(generate([legacyBase], normalizeHeroRuntime), generated);
});

test('generated carousel advances, handles reduced motion and completely disposes', (t) => {
  const dom = new JSDOM(`<div id="lightvela-intl-home"><section class="voice"><header class="voice__head"><h2 class="voice__title">Voices</h2></header><div class="marquee__rows">${['A', 'B', 'C'].map(name => `<article class="tcard"><div class="tcard__head"><img src="/lightvela-intl-home/assets/voice-xm-64.webp"><b>${name}</b><span>Place</span></div><p>Quote ${name}</p></article>`).join('')}</div></section></div>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const win = dom.window;
  const doc = win.document;
  const intervals = new Map();
  let nextTimer = 0;
  const listeners = new Set();
  const media = { matches: false, addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn) };
  win.matchMedia = () => media;
  win.setInterval = fn => { const id = ++nextTimer; intervals.set(id, fn); return id; };
  win.clearInterval = id => intervals.delete(id);
  let notify;
  let disconnected = false;
  win.IntersectionObserver = class {
    constructor(fn) { notify = fn; }
    observe() {}
    disconnect() { disconnected = true; }
  };
  const start = generated.indexOf('(function () {\n  // Center-mode testimonial carousel.');
  const end = generated.indexOf('\n\n(function () {', start);
  win.eval(generated.slice(start, end));
  const center = () => doc.querySelector('.vcar__card[data-pos="center"] .vcar__name').textContent;
  assert.equal(center(), 'B');
  assert.equal(intervals.size, 0);
  notify([{ isIntersecting: true }]);
  assert.equal(intervals.size, 1);
  [...intervals.values()][0]();
  assert.equal(center(), 'C');
  media.matches = true;
  for (const listener of listeners) listener();
  assert.equal(intervals.size, 0);
  media.matches = false;
  for (const listener of listeners) listener();
  assert.equal(intervals.size, 1);
  doc.dispatchEvent(new win.Event('lightvela-home-dispose'));
  assert.equal(intervals.size, 0);
  assert.equal(listeners.size, 0);
  assert.equal(disconnected, true);
  assert.equal(doc.querySelector('.vcar'), null);
  assert.equal(doc.querySelector('.voice').classList.contains('has-voice-carousel'), false);
  assert.equal(doc.querySelectorAll('.tcard').length, 3);
  doc.dispatchEvent(new win.Event('visibilitychange'));
  notify([{ isIntersecting: true }]);
  assert.equal(intervals.size, 0);
});

test('the importer preserves every high resolution avatar consumed by the carousel', () => {
  const preserved = new Function(`return ${importer.slice(importer.indexOf('const preservedHarnessAssetNames = [') + 'const preservedHarnessAssetNames = '.length, importer.indexOf('const preservedHarnessAssetNameSet')).trim().replace(/;$/, '')};`)();
  const dom = new JSDOM(readFileSync(new URL('../public/lightvela-intl-home/index-fragment.html', import.meta.url), 'utf8'));
  const avatars = new Set([...dom.window.document.querySelectorAll('.voice .tcard img')].map(img => img.getAttribute('src').replace(/-64\.webp(\?.*)?$/, '-128.webp').split('/').at(-1)));
  assert.equal(avatars.size, 13);
  for (const avatar of avatars) {
    assert.ok(preserved.includes(avatar), avatar);
    assert.ok(existsSync(new URL(`../public/lightvela-intl-home/assets/${avatar}`, import.meta.url)), avatar);
  }
  dom.window.close();
});
