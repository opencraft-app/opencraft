import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { FEATURE_LOCALES, localizeFeatureCards, normalizeHeroRuntime, restoreFooterBoundary } from './international-home-feature-locales.mjs';

test('hero runtime normalization removes all legacy measurements and keeps word updates', () => {
  const old = `    var measurer = el.cloneNode(false);
    measurer.removeAttribute('id');
    el.parentNode.appendChild(measurer);
    function measure(word) { measurer.textContent = word; return measurer.offsetWidth; }
    el.textContent = words[index];
    wrap.style.width = measure(words[index]) + 'px';
    function applyWord(word) {
      el.textContent = word;
      el.setAttribute('data-word', word);
      var width = measure(word);
      if (width > 0) wrap.style.width = width + 'px';
    }
`;
  const normalized = normalizeHeroRuntime(old);
  assert.doesNotMatch(normalized, /measurer|measure\(|style\.width/);
  assert.ok(normalized.includes("el.setAttribute('data-word', word)"));
  assert.equal(normalizeHeroRuntime(normalized), normalized);
  const runtime = readFileSync(new URL('../public/lightvela-intl-home/runtime.js', import.meta.url), 'utf8');
  assert.doesNotMatch(runtime, /wrap\.style\.width|var measurer = el\.cloneNode/);
  assert.equal(normalizeHeroRuntime(runtime), runtime);
  const importer = readFileSync(new URL('./import-international-homepage.mjs', import.meta.url), 'utf8');
  assert.ok(importer.includes('const runtimeSource = normalizeHeroRuntime('));
});

test('scene artwork is present once after both fresh and repeated generation', () => {
  const html = '<header class="scenes__head sr"><h2 class="scenes__title">Scenes</h2></header>';
  const once = localizeFeatureCards(html, 'en-US');
  const twice = localizeFeatureCards(once, 'en-US');
  for (const result of [once, twice]) {
    const document = new JSDOM(result).window.document;
    assert.equal(document.querySelectorAll('.scenes__mascot').length, 1);
    assert.equal(document.querySelector('.scenes__mascot img').getAttribute('src'), '/lightvela-intl-home/assets/scenes-mascot-duo.webp?v=20260930-home-visual-v1');
  }
  const importer = readFileSync(new URL('./import-international-homepage.mjs', import.meta.url), 'utf8');
  assert.ok(importer.includes('"scenes-mascot-duo.webp"'));
  assert.ok(importer.includes('if (preservedHarnessAssetNameSet.has(relativeAssetPath)) continue;'));
});

test('scene mascot cannot overflow the mobile heading row', () => {
  const css = readFileSync(new URL('../public/lightvela-intl-home/assets/hermes-home.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 899px\)[\s\S]*?\.scenes__mascot \{ display: none !important; \}/);
});

test('footer decoration preserves both CTA states and their localized source copy', () => {
  for (const href of ['/agents', '/subscribe']) {
    const cta = `<div class="foot__cta"><a href="${href}">Approved localized label <span>→</span></a></div>`;
    assert.ok(restoreFooterBoundary(`<footer class="foot">${cta}</footer>`, 'en-US').includes(cta));
  }
});

test('hero still rotates words without changing its reserved width', (t) => {
  const dom = new JSDOM('<div id="lightvela-intl-home" data-rotator-words=\'["short","a longer phrase"]\'><span class="hero__rotator-wrap" style="--hero-rotator-width: 240px"><em id="hero-rotator">short</em></span></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.matchMedia = () => ({ matches: false });
  const timers = new Map();
  let nextId = 0;
  dom.window.setTimeout = (callback, delay) => { timers.set(++nextId, { callback, delay }); return nextId; };
  dom.window.clearTimeout = (id) => timers.delete(id);
  dom.window.requestAnimationFrame = (callback) => { callback(); return 1; };
  dom.window.cancelAnimationFrame = () => {};
  const runtime = readFileSync(new URL('../public/lightvela-intl-home/runtime.js', import.meta.url), 'utf8');
  const hero = runtime.match(/\(function \(\) \{\s+var el = document\.getElementById\('hero-rotator'\);[\s\S]*?\}\)\(\);/)?.[0];
  assert.ok(hero);
  dom.window.eval(hero);
  for (const delay of [0, 2200, 260]) {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `missing timer ${delay}`);
    timers.delete(entry[0]);
    entry[1].callback();
  }
  const wrap = dom.window.document.querySelector('.hero__rotator-wrap');
  assert.equal(wrap.querySelector('#hero-rotator').textContent, 'a longer phrase');
  assert.equal(wrap.style.width, '');
  assert.equal(wrap.style.getPropertyValue('--hero-rotator-width'), '240px');
  assert.equal(wrap.children.length, 1, 'no legacy measurement node');
});

test('hero decoration has one approved asset and size in the importer', () => {
  const importer = readFileSync(new URL('./import-international-homepage.mjs', import.meta.url), 'utf8');
  assert.ok(importer.includes('"home-cover-mascot", "lv-cover-lavender.webp", 528, 410'));
  assert.ok(!importer.includes('hermes-cover-companion.webp'));
  const original = '<span class="home-cover-mascot"><img src="approved.webp" width="528" height="410"></span>';
  assert.ok(localizeFeatureCards(original, 'en-US').includes(original));
});

test('footer has no obsolete mascot rule, injection or note asset', () => {
  const css = readFileSync(new URL('../public/lightvela-intl-home/assets/hermes-home.css', import.meta.url), 'utf8');
  const importer = readFileSync(new URL('./import-international-homepage.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /home-footer-mascot|hermes-door-note|home-door-note/);
  assert.doesNotMatch(importer, /home-footer-mascot|hermes-door-note/);
  assert.ok(!existsSync(new URL('../public/lightvela-intl-home/assets/hermes-door-note.webp', import.meta.url)));
});

test('generated hero styles discard captured widths but preserve reveal timing', () => {
  for (const width of [94, 160, 999]) {
    const source = `<span class="hero__rotator-wrap" style="width: ${width}px; --rotator-delay: 1150ms; --hero-rotator-width: 777px;">`;
    assert.equal(localizeFeatureCards(source, 'en-US'), '<span class="hero__rotator-wrap" style="--rotator-delay: 1150ms;">');
  }
  for (const locale of ['', ...FEATURE_LOCALES]) {
    const html = readFileSync(new URL(`../public/lightvela-intl-home/index-fragment${locale ? `.${locale}` : ''}.html`, import.meta.url), 'utf8');
    assert.match(html, /class="hero__rotator-wrap" style="--rotator-delay: [^;"]+;"/);
  }
});

test('footer display font is defined and its local font asset exists', () => {
  const css = readFileSync(new URL('../public/lightvela-intl-home/style.css', import.meta.url), 'utf8');
  assert.match(css, /--font-footer-display:\s*'Allura'/);
  assert.match(css, /font-family:\s*'Allura';[^}]*assets\/fonts\/allura-latin\.woff2/s);
  assert.ok(readFileSync(new URL('../public/lightvela-intl-home/assets/fonts/allura-latin.woff2', import.meta.url)).length > 0);
});

test('step mascot uses only original artwork sizing, without superseded background assets', () => {
  const css = readFileSync(new URL('../public/lightvela-intl-home/assets/hermes-home.css', import.meta.url), 'utf8');
  assert.equal((css.match(/\.home-step-mascot img\s*\{/g) ?? []).length, 1);
  assert.match(css, /\.home-step-mascot img\s*\{[^}]*display: block;[^}]*width: 112px;/);
  assert.match(css, /\.home-step-mascot\s*\{[^}]*left: var\(--step-left\);[^}]*top: var\(--step-top, 80px\)/);
  for (const asset of ['hermes-cover-companion.webp', 'figma-steps-companion.webp']) {
    assert.ok(!css.includes(asset));
    assert.ok(!existsSync(new URL(`../public/lightvela-intl-home/assets/${asset}`, import.meta.url)));
  }
});

test('fresh and legacy step imports converge on one artwork and foot anchor', (t) => {
  const track = '<ol class="track sr sr--d1 is-in" data-test="preserved"></ol>';
  const fresh = localizeFeatureCards(track, 'en-US');
  const legacy = localizeFeatureCards('<span class="home-step-mascot" aria-hidden="true"><img src="hermes-black-companion.webp" width="460" height="500"></span>' + track, 'en-US');
  assert.equal(legacy, fresh);
  assert.equal(localizeFeatureCards(fresh, 'en-US'), fresh);
  const dom = new JSDOM(fresh);
  t.after(() => dom.window.close());
  const mascot = dom.window.document.querySelector('.home-step-mascot');
  const image = mascot.querySelector('img');
  assert.equal(image.getAttribute('src'), '/lightvela-intl-home/assets/figma-steps-user-original.webp?v=20260930-home-visual-v1');
  assert.equal(image.getAttribute('width'), '676');
  assert.equal(image.getAttribute('height'), '591');
  assert.equal(mascot.dataset.footY, '520');
  assert.equal(mascot.nextElementSibling.getAttribute('data-test'), 'preserved');
  const importer = readFileSync(new URL('./import-international-homepage.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(importer, /"home-step-mascot"/);
});

test('step placement scales the generated foot anchor using the rendered artwork', (t) => {
  const html = localizeFeatureCards('<div class="deploy"><div class="track"></div></div>', 'en-US');
  const dom = new JSDOM(`<div id="lightvela-intl-home">${html}</div>`, { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.window.matchMedia = (query) => ({ matches: query === '(min-width: 900px)', addEventListener() {}, removeEventListener() {} });
  const document = dom.window.document;
  document.querySelector('.deploy').getBoundingClientRect = () => ({ left: 10, top: 100 });
  document.querySelector('.track').getBoundingClientRect = () => ({ left: 30, top: 300, width: 1000 });
  const mascot = document.querySelector('.home-step-mascot');
  let renderedWidth = 112;
  mascot.querySelector('img').getBoundingClientRect = () => ({ width: renderedWidth });
  dom.window.eval(readFileSync(new URL('../public/lightvela-intl-home/assets/feature-motion.js', import.meta.url), 'utf8'));
  assert.equal(parseFloat(mascot.style.getPropertyValue('--step-left')), 764);
  assert.equal(parseFloat(mascot.style.getPropertyValue('--step-top')), 200 - 112 + 132 * 70 / 170 - 112 * 520 / 676);
  renderedWidth = 224;
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  assert.equal(parseFloat(mascot.style.getPropertyValue('--step-left')), 708);
  assert.equal(parseFloat(mascot.style.getPropertyValue('--step-top')), 200 - 112 + 132 * 70 / 170 - 224 * 520 / 676);
});

test('shared hero centers phrases without moving the companion and separates mobile rows', () => {
  const css = readFileSync(new URL('../public/lightvela-intl-home/assets/hermes-home.css', import.meta.url), 'utf8');
  assert.match(css, /\.hero__line--dynamic \.hero__rotator-wrap\s*\{[^}]*width: var\(--hero-rotator-width, 12em\)[^}]*text-align: center;/);
  assert.match(css, /\.hero__line--dynamic\s*\{[^}]*font-size: 22px;[^}]*row-gap: 32px;/);
});

test('channel times are unique per platform and stable across carousel copies', () => {
  const dom = new JSDOM('<div id="lightvela-intl-home">' + ['WhatsApp', 'Telegram', 'WhatsApp'].map((name) => `<div class="feature-motion-channel"><span>${name}<small>17:25</small></span></div>`).join('') + '</div>', { runScripts: 'outside-only' });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.Math.random = () => 0.5;
  const script = readFileSync(new URL('../public/lightvela-intl-home/assets/feature-motion.js', import.meta.url), 'utf8');
  dom.window.eval(script);
  const times = [...dom.window.document.querySelectorAll('small')].map((node) => node.textContent);
  assert.deepEqual(times, ['12:00', '12:01', '12:00']);
  dom.window.eval(script);
  assert.deepEqual([...dom.window.document.querySelectorAll('small')].map((node) => node.textContent), times);
  dom.window.close();
});

test('sentence suffix stays inside the reserved hero phrase before the mascot', () => {
  const dom = new JSDOM('<div id="lightvela-intl-home" data-rotator-words=\'["仕事の相棒"]\'><span class="hero__rotator-wrap"><em id="hero-rotator">仕事の相棒</em><span class="hero__rotator-line"></span><span class="home-cover-mascot"></span></span><span class="hero__suffix">になります</span></div>', { runScripts: 'outside-only' });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.eval(readFileSync(new URL('../public/lightvela-intl-home/assets/feature-motion.js', import.meta.url), 'utf8'));
  const wrap = dom.window.document.querySelector('.hero__rotator-wrap');
  assert.equal(wrap.querySelector('.hero__suffix').textContent, 'になります');
  assert.equal(wrap.querySelector('.hero__suffix').nextElementSibling.className, 'hero__rotator-line');
  dom.window.close();
});

test('footer handwriting has Latin, CJK and Hangul font stacks', () => {
  const css = readFileSync(new URL('../public/lightvela-intl-home/assets/hermes-home.css', import.meta.url), 'utf8');
  assert.ok(css.includes("font-family: 'Allura', 'STXingkai'"));
  assert.ok(css.includes("font-family: 'Allura', 'Nanum Brush Script'"));
  assert.ok(css.includes('font-family: var(--font-footer-display) !important; font-weight: 400 !important;'));
});

test('all Figma assets referenced by homepage CSS are retained during import', () => {
  const css = readFileSync(new URL('../public/lightvela-intl-home/assets/hermes-home.css', import.meta.url), 'utf8');
  const importer = readFileSync(new URL('./import-international-homepage.mjs', import.meta.url), 'utf8');
  const preserved = importer.split('const preservedHarnessAssetNames = [')[1].split('];')[0];
  const assets = new Set([...css.matchAll(/assets\/(figma-[^'"?)]+)/g)].map((match) => match[1]));
  assert.ok(assets.has('figma-feature-cloud-agent-matte.webp'));
  for (const asset of assets) {
    assert.ok(preserved.includes(`"${asset}"`), `${asset} must survive target directory recreation`);
    assert.ok(readFileSync(new URL(`../public/lightvela-intl-home/assets/${asset}`, import.meta.url)).length > 0);
  }
});

for (const locale of FEATURE_LOCALES) {
  test(`${locale}: footer boundary and localized artwork survive reimport`, (t) => {
    const html = readFileSync(new URL(`../public/lightvela-intl-home/index-fragment.${locale}.html`, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /\\n\s*$/);
    assert.equal(localizeFeatureCards(html, locale), html);
    const dom = new JSDOM(html);
    t.after(() => dom.window.close());
    const document = dom.window.document;
    const captions = [...document.querySelectorAll('.wcard__body > p')];
    assert.equal(captions.length, 1);
    const bodies = [...document.querySelectorAll('.wcard__body')];
    assert.equal(bodies.length, 7, `${locale}: all capability bodies must exist`);
    assert.ok(bodies[3]);
    assert.ok(bodies[3].querySelector('h4.wcard__workspace-title'));
    assert.equal(document.querySelectorAll('.wcard__body > h4').length, 7);
    assert.match(html, /feature-motion-skills[^>]*>\n/);
    for (const index of [0, 2, 4, 5, 6]) {
      const body = bodies[index];
      assert.ok(body, `${locale}: missing card ${index}`);
      assert.equal(body.querySelector('p'), null);
    }
    const confirmation = document.querySelector('.wcard--confirm .feature-copy-preview');
    assert.ok(confirmation);
    assert.equal(confirmation.closest('[aria-hidden="true"]'), null, 'confirmation copy must be readable');
    for (const selector of ['.home-cover-mascot', '.home-step-mascot', '.home-cta-mascot']) {
      const decoration = document.querySelector(selector);
      assert.ok(decoration, `${locale}: missing ${selector}`);
      assert.equal(decoration.getAttribute('aria-hidden'), 'true');
      assert.equal(decoration.querySelector('img')?.getAttribute('alt'), '');
    }
    assert.ok(document.querySelector('.cta__acts .btn-dark > .home-cta-mascot:first-child'), `${locale}: CTA companion rides on the trial button`);
    const voiceHead = document.querySelector('#voice > .voice__head:first-child');
    assert.ok(voiceHead, `${locale}: user voice section keeps its heading`);
    assert.ok(voiceHead.querySelector('h2.voice__title')?.textContent.trim(), `${locale}: user voice heading has copy`);
    assert.equal(document.querySelector('.home-footer-boundary svg')?.getAttribute('aria-hidden'), 'true');
    for (const icon of document.querySelectorAll('.feature-motion-channel img')) {
      assert.equal(icon.getAttribute('alt'), '', 'duplicate decorative channel icon');
      assert.ok(icon.closest('[aria-hidden="true"]'));
    }
    for (const caption of captions) {
      assert.equal(caption.children.length, 0, `${locale}: concise caption has no forced break or partial bold phrase`);
      assert.ok(caption.textContent.trim().length > 0);
    }
    const originals = [...html.matchAll(/<div class="aut__case aut__case--\d+">[\s\S]*?<\/div>/g)].map(([markup]) => markup.replaceAll('aut__', 'feature-task__'));
    assert.equal(originals.length, 3);
    for (const scenario of originals) assert.ok(html.includes(scenario.replace(/(<p class="feature-task__bubble feature-task__bubble--agent">)(?!<b>)/, '$1<b>LightVela</b>')), 'animated scenario preserves original localized content');
    assert.equal((html.match(/class="feature-task__case /g) ?? []).length, 3);
    assert.equal((html.match(/class="feature-motion-page"/g) ?? []).length, 3);
    assert.equal((html.match(/class="feature-motion-channel"/g) ?? []).length, 12);
    assert.ok(!html.includes('feature-copy-preview--scheduled'));
    assert.equal((html.match(/class="home-footer-boundary"/g) ?? []).length, 1);
    assert.ok(html.indexOf('class="home-footer-boundary"') < html.indexOf('class="foot__top"'));
    assert.ok(html.indexOf('class="foot__top"') < html.indexOf('class="foot__links"'));
    assert.ok(!html.includes('class="home-footer-mascot"'));
    assert.ok(!html.includes('class="home-door-note"'));
    const door = document.querySelector('.home-footer-boundary svg');
    assert.equal(door.getAttribute('viewBox'), '0 0 964 966');
    assert.equal(door.getAttribute('preserveAspectRatio'), 'xMidYMid meet');
    assert.equal(door.querySelector('clipPath, path'), null, 'no legacy door clipping or ground overlay');
    const artwork = door.querySelector('image');
    assert.equal(artwork.getAttribute('href'), '/lightvela-intl-home/assets/hermes-door.webp?v=20260930-home-visual-v1');
    assert.equal(artwork.getAttribute('width'), '964');
    assert.equal(artwork.getAttribute('height'), '966');
    assert.equal(artwork.getAttribute('preserveAspectRatio'), 'xMidYMid meet');
    assert.equal(artwork.hasAttribute('clip-path'), false);
    if (locale !== 'en-US') assert.ok(!html.includes('Open a brighter way of working.'));
  });
}
