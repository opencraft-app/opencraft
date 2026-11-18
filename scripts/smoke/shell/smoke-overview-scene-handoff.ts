import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? '.local/overview-scene-handoff');
await mkdir(output, { recursive: true });
const negative = process.argv.includes('--negative-control');
const baseline = process.env.OPENCRAFT_SCENE_BASELINE_ROOT;
assert(!negative || baseline, 'negative control needs an explicit unmodified source root');
const original = new Map<string, string>();
if (negative) for (const file of [
  'apps/workbench-web/src/components/overview-scene-motion.ts',
  'apps/workbench-web/src/components/scene-transition.ts',
  'apps/workbench-web/src/components/app-shell.tsx',
  'apps/workbench-web/src/components/right-panel.tsx',
  'apps/workbench-web/src/components/panel-mobile-toolbar.scss',
  'apps/workbench-web/src/components/retained-view-preview.tsx',
  'apps/workbench-web/src/styles/app.scss',
])
  original.set(resolve(file), await readFile(resolve(baseline!, file), 'utf8'));
const vite = await createServer({ configFile: 'apps/workbench-web/vite.config.ts', root: process.cwd(), logLevel: 'error',
  cacheDir: 'node_modules/.vite-scene-handoff', server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{
    name: 'scene-handoff-fixture', enforce: 'pre', load: id => original.get(id.split('?')[0]!),
    transform(code, id) {
      if (!id.endsWith('/overview-scene-motion.ts')) return;
      const enter = 'if (!entering && !returning && prepared && cardness <= handback && finishScene) {';
      const leave = 'else clean();\n        });';
      assert(code.includes(enter) && code.includes(leave), 'instrument actual scene commit, not a parallel mock');
      return code.replace(enter, enter + '\n(window as any).sceneHandoffProbe?.("before", {key, scene, cardness});')
        .replace(leave, leave + '\n(window as any).sceneHandoffProbe?.("after", {key, scene, cardness});');
    },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/?')) return next();
      res.setHeader('content-type', 'text/html');
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/overview-chat-reading.tsx"></script>');
    }); },
  }] });
const cases = [
  { name: 'long-main', short: false },
  { name: 'short-main', short: true },
  { name: 'long-tool-resize', short: false, tool: true, height: 760 },
  { name: 'short-tool-resize', short: true, tool: true, height: 760 },
  { name: 'short-tool-rotate', short: true, tool: true, height: 760, width: 520 },
  { name: 'long-tool-midflight-resize', short: false, tool: true, during: true, height: 760, width: 520 },
  { name: 'draft-midflight-resize', short: true, draft: true, during: true, height: 760 },
  { name: 'draft-resize', short: true, draft: true, height: 760 },
  { name: 'cancel-resize', short: false, cancel: true, height: 760 },
  { name: 'wide-keyboard', short: false, initialWidth: 1280, height: 780, width: 1100 },
];
const receipt: unknown[] = [];
const nextFrames = async (page: import('playwright').Page, count: number) => page.evaluate(count => new Promise<void>(resolve => {
  let frames = 0; const step = () => ++frames < count ? requestAnimationFrame(step) : resolve(); requestAnimationFrame(step);
}), count);
try {
  await vite.listen();
  for (const placement of ['atomic', 'popover'] as const) {
    const browser = await chromium.launch({ headless: true });
    try { for (const scenario of cases.filter(c => !process.env.OPENCRAFT_SCENE_CASE || c.name === process.env.OPENCRAFT_SCENE_CASE)) {
      const page = await browser.newPage({ viewport: { width: scenario.initialWidth ?? 390, height: 844 }, hasTouch: true });
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript('window.__name=v=>v');
      if (placement === 'popover') await page.addInitScript('delete Element.prototype.moveBefore');
      await page.goto(vite.resolvedUrls!.local[0]! + '?safe=34px' + (scenario.short ? '&short' : '') + (scenario.draft ? '&draft' : ''), { waitUntil: 'commit' });
      await page.waitForFunction(() => !!(window as any).readingOverview?.destination);
      await page.getByRole('button', { name: 'Tabs', exact: true }).last().click();
      await page.getByRole('button', { name: 'Main chat', exact: true }).click();
      await page.waitForFunction(() => !(window as any).readingOverview.open);
      await page.evaluate(() => document.fonts.ready);
      await page.locator('.opencraft-composer-editor').click(); await page.keyboard.insertText('Keep handoff draft');
      const editor = await page.locator('.opencraft-composer-editor').elementHandle();
      const root = await page.locator('[data-retained-view="primary-chat"]').elementHandle();
      if (scenario.tool) {
        await page.locator('[data-testid="composer-panel-toggle"]').click();
        await page.getByRole('button', { name: 'Open document', exact: true }).click();
        await page.waitForFunction(() => !(window as any).readingOverview.open);
      }
      await page.evaluate(() => {
        const w = window as any; w.handoffs = []; w.afterFrames = []; w.capture = false;
        w.readHandoff = (phase: string, extra?: any) => {
          const root = document.querySelector<HTMLElement>('[data-retained-view="primary-chat"]')!;
          const home = document.querySelector<HTMLElement>('.main-content-slot')!;
          const scroll = root.querySelector<HTMLElement>('.thread-scroll');
          const tail = (scroll ? [...scroll.querySelectorAll('p')].at(-1) : root.querySelector('.opencraft-composer-editor'))!;
          const footer = root.querySelector('.thread-scroll-footer');
          return { phase, extra, root: root.getBoundingClientRect().toJSON(), home: home.getBoundingClientRect().toJSON(),
            tail: tail.getBoundingClientRect().toJSON(), scroll: scroll?.scrollTop, readingAllocation: document.querySelector('.main-content-surface')?.hasAttribute('data-primary-reading') ?? false,
            reading: !!scroll, borrowed: root.dataset.retainedPreview === 'true', footer: footer ? getComputedStyle(footer).paddingBottom : null };
        };
        w.sceneHandoffProbe = (phase: string, extra: any) => {
          if (extra.key !== JSON.stringify(['primary-chat', 'scope'])) return;
          w.handoffs.push(w.readHandoff(phase, extra));
          if (phase === 'after') {
            w.capture = true;
            const sample = () => { if (!w.capture) return; w.afterFrames.push(w.readHandoff('frame')); requestAnimationFrame(sample); }; requestAnimationFrame(sample);
          }
        };
      });
      if (scenario.tool) await page.locator('[data-reading-tool]').getByRole('button', { name: 'Tabs', exact: true }).click();
      else await page.locator('[data-testid="composer-panel-toggle"]').click();
      await page.getByRole('button', { name: 'Main chat', exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector('[data-overview-flight]'));
      if (scenario.height && !scenario.during) await page.setViewportSize({ width: scenario.width ?? scenario.initialWidth ?? 390, height: scenario.height });
      await nextFrames(page, 3);
      if (scenario.cancel) await page.keyboard.press('Escape');
      else if (scenario.initialWidth) { await page.getByRole('button', { name: 'Main chat', exact: true }).focus(); await page.keyboard.press('Enter'); }
      else await page.getByRole('button', { name: 'Main chat', exact: true }).tap();
      if (scenario.during) {
        await page.waitForFunction(() => {
          const flight = document.querySelector<HTMLElement>('[data-overview-flight]');
          const width = flight?.getBoundingClientRect().width ?? 0;
          return document.querySelector('[data-overview-phase="exiting"]') && width > 210 && width < 350;
        });
        await page.setViewportSize({ width: scenario.width ?? 390, height: scenario.height! });
      }
      await page.waitForFunction(() => !(window as any).readingOverview.open);
      await nextFrames(page, 10);
      const capture = await page.evaluate(() => { const w = window as any; w.capture = false; return { handoffs: w.handoffs, frames: w.afterFrames }; });
      const label = placement + '-' + scenario.name;
      await writeFile(output + '/' + label + '.json', JSON.stringify(capture, null, 2));
      const before = capture.handoffs.find((frame: any) => frame.phase === 'before');
      const after = capture.handoffs.find((frame: any) => frame.phase === 'after');
      assert(before && after && capture.frames.length >= 8, 'must observe actual commit and later paints: ' + label);
      const faults: string[] = [];
      const near = (a: number, b: number, message: string) => { if (Math.abs(a - b) > 1) faults.push(message + ` ${a} != ${b}`); };
      for (const axis of ['x', 'y', 'width', 'height']) {
        near(before.extra.scene[axis], after.home[axis], 'flight endpoint versus allocated home ' + axis);
        near(before.root[axis], after.root[axis], 'no second source resize ' + axis);
        for (const frame of capture.frames) near(frame.root[axis], after.root[axis], 'no late root resize ' + axis);
      }
      near(before.tail.bottom, after.tail.bottom, 'global text/editor position at commit');
      for (const frame of capture.frames) {
        near(frame.tail.bottom, after.tail.bottom, 'global text/editor position after commit');
        if (!negative) assert.equal(frame.readingAllocation, after.reading, 'primary layout semantics survive placement changes');
      }
      if (!negative) { assert.equal(before.readingAllocation, before.reading, 'only the primary reader allocates transcript bleed'); assert.deepEqual(faults, [], label); }
      assert.equal(after.borrowed, false);
      assert.equal(await editor!.evaluate(node => node === document.querySelector('.opencraft-composer-editor')), true);
      assert.equal(await root!.evaluate(node => node === document.querySelector('[data-retained-view="primary-chat"]')), true);
      assert.equal(await page.locator('.opencraft-composer-editor').innerText(), 'Keep handoff draft');
      assert.deepEqual(errors, []);
      await page.screenshot({ path: output + '/' + label + '.png' });
      receipt.push({ label, faults, frames: capture.frames.length }); console.log(label, 'geometry faults', faults.length);
      await page.close();
    }} finally { await browser.close(); }
  }
  if (negative) assert(receipt.some((entry: any) => entry.faults.length > 0), 'original must reproduce a real endpoint/late-resize failure');
  await writeFile(output + '/receipt.json', JSON.stringify({ negative, cases: receipt }, null, 2));
} finally { await vite.close(); }
