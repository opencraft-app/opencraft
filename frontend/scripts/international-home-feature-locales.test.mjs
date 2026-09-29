import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { localizeFeatureCards, restoreFooterBoundary } from './international-home-feature-locales.mjs';

test('footer decoration preserves both CTA states and their localized source copy', () => {
  for (const href of ['/agents', '/subscribe']) {
    const cta = `<div class="foot__cta"><a href="${href}">Approved localized label <span>→</span></a></div>`;
    assert.ok(restoreFooterBoundary(`<footer class="foot">${cta}</footer>`, 'en-US').includes(cta));
  }
});

test('hero decoration has one approved asset and size in the importer', () => {
  const importer = readFileSync(new URL('./import-international-homepage.mjs', import.meta.url), 'utf8');
  assert.ok(importer.includes('"home-cover-mascot", "lv-cover-lavender.webp", 528, 410'));
  assert.ok(!importer.includes('hermes-cover-companion.webp'));
  const original = '<span class="home-cover-mascot"><img src="approved.webp" width="528" height="410"></span>';
  assert.ok(localizeFeatureCards(original, 'en-US').includes(original));
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

for (const locale of ['en-US', 'zh-CN', 'zh-SG', 'zh-Hant', 'id-ID', 'es', 'ja-JP', 'ko-KR']) {
  test(`${locale}: footer boundary and localized artwork survive reimport`, () => {
    const html = readFileSync(new URL(`../public/lightvela-intl-home/index-fragment.${locale}.html`, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /\\n\s*$/);
    assert.equal(localizeFeatureCards(html, locale), html);
    const document = new JSDOM(html).window.document;
    const captions = [...document.querySelectorAll('.wcard__body > p')];
    assert.equal(captions.length, 1);
    const bodies = [...document.querySelectorAll('.wcard__body')];
    assert.ok(bodies[3].querySelector('h4.wcard__workspace-title'));
    assert.equal(document.querySelectorAll('.wcard__body > h4').length, 7);
    assert.match(html, /feature-motion-skills[^>]*>\n/);
    for (const index of [0, 2, 4, 5, 6]) assert.equal(bodies[index].querySelector('p'), null);
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
    assert.match(html, /stroke="#696969"/);
    if (locale !== 'en-US') assert.ok(!html.includes('Open a brighter way of working.'));
  });
}
